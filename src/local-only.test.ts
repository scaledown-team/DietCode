/**
 * Per-stage cloud controls (issue #21): local-only mode needs no API key and
 * keeps the proxy from calling Scaledown, and `clear-cache` removes the local
 * proxy store. Hook-level "no request" checks live in hooks/hook-contract.test.ts.
 */

import { jest } from "@jest/globals";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import { resolve } from "path";
import type { ScaledownClient } from "./client.js";

// Keep config, stats and proxy state out of the real home dir: jest's ESM
// sandbox doesn't propagate process.env.HOME to os.homedir().
const home = mkdtempSync(resolve(os.tmpdir(), "dietcode-local-"));
jest.unstable_mockModule("os", () => ({ ...os, homedir: () => home }));
const { loadConfig } = await import("./config.js");
const { startProxy } = await import("./proxy/server.js");
const { clearProxyStore, putOriginal, sessionDir, cacheDir } = await import("./proxy/store.js");

const ENV_KEYS = [
  "SCALEDOWN_API_KEY",
  "SCALEDOWN_LOCAL_ONLY",
  "SCALEDOWN_CLASSIFY_DISABLE",
  "SCALEDOWN_POST_TOOL_LOCAL_ONLY",
  "SCALEDOWN_PROXY_DISABLE",
  "SCALEDOWN_PROXY_COMPACT_THRESHOLD",
  "SCALEDOWN_PROXY_RECENT_TURNS",
  "SCALEDOWN_PROXY_FOLD_TURNS",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("loadConfig stage controls", () => {
  it("defaults keep every stage enabled", () => {
    process.env.SCALEDOWN_API_KEY = "k";
    const c = loadConfig();
    expect(c.classifyDisable).toBe(false);
    expect(c.postToolLocalOnly).toBe(false);
    expect(c.localOnly).toBe(false);
    expect(c.proxy.disable).toBe(false);
  });

  it("classification can be disabled without touching other stages", () => {
    process.env.SCALEDOWN_API_KEY = "k";
    process.env.SCALEDOWN_CLASSIFY_DISABLE = "true";
    const c = loadConfig();
    expect(c.classifyDisable).toBe(true);
    expect(c.postToolLocalOnly).toBe(false);
    expect(c.postToolDisable).toBe(false);
    expect(c.proxy.disable).toBe(false);
  });

  it("SCALEDOWN_LOCAL_ONLY needs no API key and disables every remote stage", () => {
    process.env.SCALEDOWN_LOCAL_ONLY = "true";
    const c = loadConfig();
    expect(c.apiKey).toBe("");
    expect(c.classifyDisable).toBe(true);
    expect(c.postToolLocalOnly).toBe(true);
    expect(c.proxy.disable).toBe(true);
  });

  it("still requires an API key outside local-only mode", () => {
    expect(() => loadConfig()).toThrow(/SCALEDOWN_API_KEY/);
  });
});

describe("proxy in local-only mode", () => {
  let upstream: Server;
  let upstreamUrl = "";
  let forwarded: string[] = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        forwarded.push(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
    const sym = Object.getOwnPropertySymbols(globalThis).find((s) =>
      s.toString().includes("undici.globalDispatcher")
    );
    const dispatcher = sym
      ? (globalThis as unknown as Record<symbol, { destroy?: () => Promise<void> }>)[sym]
      : undefined;
    await dispatcher?.destroy?.().catch(() => {});
  });

  beforeEach(() => {
    forwarded = [];
  });

  let seq = 0;
  const body = () =>
    JSON.stringify({
      model: "claude-x",
      system: [{ type: "text", text: "SYS" }],
      messages: [
        { role: "user", content: `u0 #${seq++} ${"lots of detail ".repeat(200)}` },
        { role: "assistant", content: `a0 ${"long answer ".repeat(200)}` },
        { role: "user", content: "u1 do thing two" },
        { role: "assistant", content: "a1 done two" },
        { role: "user", content: "u2 do thing three" },
        { role: "assistant", content: "a2 done three" },
        { role: "user", content: "u3 latest" },
      ],
    });

  async function sendThroughProxy(): Promise<{ summarizeCalls: number; sent: string; received: string }> {
    process.env.SCALEDOWN_PROXY_COMPACT_THRESHOLD = "1"; // would force a compaction step
    process.env.SCALEDOWN_PROXY_RECENT_TURNS = "2";
    const config = { ...loadConfig(), proxy: { ...loadConfig().proxy, upstream: upstreamUrl, port: 0 } };
    let summarizeCalls = 0;
    const client = {
      summarize: async () => {
        summarizeCalls++;
        return { summary: "PROXY SUMMARY", input_chars: 0, output_chars: 13, latency_ms: 0 };
      },
    } as unknown as ScaledownClient;
    const proxy = await startProxy(config, client, 0);
    const sent = body();
    try {
      await fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sent,
      }).then((r) => r.text());
    } finally {
      proxy.closeAllConnections?.();
      await new Promise<void>((r) => proxy.close(() => r()));
    }
    return { summarizeCalls, sent, received: forwarded[0] ?? "" };
  }

  it("control: with an API key the same request is summarized via Scaledown", async () => {
    process.env.SCALEDOWN_API_KEY = "k";
    const { summarizeCalls, received } = await sendThroughProxy();
    expect(summarizeCalls).toBe(1);
    expect(received).toContain("PROXY SUMMARY");
  });

  it("local-only: forwards the request unchanged and never calls Scaledown", async () => {
    process.env.SCALEDOWN_LOCAL_ONLY = "true";
    const { summarizeCalls, sent, received } = await sendThroughProxy();
    expect(summarizeCalls).toBe(0);
    expect(received).toBe(sent);
  });
});

describe("clearProxyStore", () => {
  it("removes proxy session state and stashed originals, nothing else", () => {
    clearProxyStore(); // start from a known-empty store
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(resolve(sessionDir(), "s1.json"), "{}");
    putOriginal("original text", "compressed");
    const statsFile = resolve(home, ".scaledown", "stats.json");
    writeFileSync(statsFile, "{}");

    expect(clearProxyStore()).toEqual({ sessions: 1, originals: 1 });
    expect(existsSync(sessionDir())).toBe(false);
    expect(existsSync(cacheDir())).toBe(false);
    expect(readdirSync(resolve(home, ".scaledown"))).toEqual(["stats.json"]);
    expect(clearProxyStore()).toEqual({ sessions: 0, originals: 0 });
  });
});
