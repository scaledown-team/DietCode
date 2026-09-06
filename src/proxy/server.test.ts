import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { startProxy } from "./server.js";
import type { ScaledownClient } from "../client.js";
import type { Config } from "../config.js";

// ---- a stub upstream that records what the proxy forwards ----
interface Captured {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => res(d));
  });
}

let upstream: Server;
let upstreamPort: number;
let lastReq: Captured | null = null;

let proxy: Server;
let proxyPort: number;

let home: string;
let prevHome: string | undefined;

const fakeClient = {
  summarize: async () => ({
    summary: "PROXY SUMMARY",
    input_chars: 0,
    output_chars: 0,
    latency_ms: 0,
  }),
} as unknown as ScaledownClient;

function makeConfig(upstreamUrl: string): Config {
  return {
    apiKey: "test",
    compressThreshold: 10000,
    compressRate: "auto",
    niahDisable: false,
    postToolDisable: false,
    postToolThreshold: 4000,
    compactThreshold: 50,
    showProgress: false,
    maxContextTokens: 200000,
    proxy: {
      port: 0,
      upstream: upstreamUrl,
      recentTurns: 2,
      blockThreshold: 2000,
      compactThreshold: 1, // force a compaction step
      disable: false,
      blockCompress: false,
      foldEveryTurns: 3,
      cacheControlDisable: false,
    },
  };
}

beforeAll(async () => {
  prevHome = process.env.HOME;
  home = mkdtempSync(resolve(tmpdir(), "dietcode-server-"));
  process.env.HOME = home;

  upstream = createServer(async (req, res) => {
    lastReq = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: await readBody(req),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, echoPath: req.url }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  proxy = await startProxy(makeConfig(`http://127.0.0.1:${upstreamPort}`), fakeClient, 0);
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  // Drop lingering keep-alive sockets (undici pools them) so the worker exits.
  proxy.closeAllConnections?.();
  upstream.closeAllConnections?.();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  // The proxy uses global fetch (undici), whose pooled connections keep the
  // event loop alive; close the lazily-created global dispatcher.
  const sym = Object.getOwnPropertySymbols(globalThis).find((s) =>
    s.toString().includes("undici.globalDispatcher")
  );
  const dispatcher = sym
    ? (globalThis as unknown as Record<symbol, { destroy?: () => Promise<void> }>)[sym]
    : undefined;
  await dispatcher?.destroy?.().catch(() => {});
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  lastReq = null;
});

const sampleBody = () =>
  JSON.stringify({
    model: "claude-x",
    system: [{ type: "text", text: "SYS" }],
    messages: [
      { role: "user", content: "u0 do thing one with lots of detail" },
      { role: "assistant", content: "a0 done one" },
      { role: "user", content: "u1 do thing two" },
      { role: "assistant", content: "a1 done two" },
      { role: "user", content: "u2 do thing three" },
      { role: "assistant", content: "a2 done three" },
      { role: "user", content: "u3 latest" },
    ],
  });

describe("/v1/messages", () => {
  it("forwards a compacted body upstream and passes auth headers through", async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "secret-key", "anthropic-version": "2023-06-01" },
      body: sampleBody(),
    });
    const json = (await resp.json()) as { ok: boolean };

    expect(json.ok).toBe(true); // streamed back from upstream
    expect(lastReq).not.toBeNull();
    expect(lastReq!.headers["x-api-key"]).toBe("secret-key");
    expect(lastReq!.headers["anthropic-version"]).toBe("2023-06-01");

    const forwarded = JSON.parse(lastReq!.body) as {
      system: unknown;
      messages: Array<{ role: string; content: unknown }>;
    };
    // system untouched, history compacted to a summary + tail.
    expect(forwarded.system).toEqual([{ type: "text", text: "SYS" }]);
    expect(forwarded.messages.length).toBeLessThan(7);
    expect(JSON.stringify(forwarded.messages[0].content)).toContain("PROXY SUMMARY");
  });
});

describe("passthrough", () => {
  it("forwards non-messages paths unchanged", async () => {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, { method: "GET" });
    const json = (await resp.json()) as { echoPath: string };
    expect(json.echoPath).toBe("/v1/models");
    expect(lastReq!.method).toBe("GET");
    expect(lastReq!.url).toBe("/v1/models");
  });
});
