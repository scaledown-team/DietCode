/**
 * Savings accounting in the proxy (issue #18): only generation requests that
 * the upstream accepted are booked, count_tokens never is, and the net-dollar
 * estimate is passed through with its sign.
 */

import { jest } from "@jest/globals";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import * as os from "os";
import { resolve } from "path";
import type { ScaledownClient } from "../client.js";
import type { Config } from "../config.js";

// Keep session state / stats out of the real home dir: jest's ESM sandbox
// doesn't propagate process.env.HOME to os.homedir().
let home = "";
jest.unstable_mockModule("os", () => ({ ...os, homedir: () => home }));
const addSaving = jest.fn();
const addRequest = jest.fn();
jest.unstable_mockModule("../stats.js", () => ({ addSaving, addRequest }));
const { startProxy } = await import("./server.js");

let upstream: Server;
let proxy: Server;
let proxyPort: number;
let upstreamStatus = 200;
let summaryOutputChars = 0;

const fakeClient = {
  summarize: async () => ({
    summary: "PROXY SUMMARY",
    input_chars: 0,
    output_chars: summaryOutputChars,
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

// Distinct first message per call → distinct session, so every request folds.
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

function post(path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(),
  });
}

beforeAll(async () => {
  home = mkdtempSync(resolve(os.tmpdir(), "dietcode-accounting-"));
  upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(upstreamStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: upstreamStatus }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  proxy = await startProxy(makeConfig(`http://127.0.0.1:${upstreamPort}`), fakeClient, 0);
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  proxy.closeAllConnections?.();
  upstream.closeAllConnections?.();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  const sym = Object.getOwnPropertySymbols(globalThis).find((s) =>
    s.toString().includes("undici.globalDispatcher")
  );
  const dispatcher = sym
    ? (globalThis as unknown as Record<symbol, { destroy?: () => Promise<void> }>)[sym]
    : undefined;
  await dispatcher?.destroy?.().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  addSaving.mockClear();
  addRequest.mockClear();
  upstreamStatus = 200;
  summaryOutputChars = 0;
});

describe("proxy savings accounting", () => {
  it("books a successful /v1/messages request", async () => {
    await (await post("/v1/messages")).text();
    expect(addRequest).toHaveBeenCalledTimes(1);
    expect(addSaving).toHaveBeenCalledTimes(1);
    const [, tokens, netUsd] = addSaving.mock.calls[0] as [string, number, number];
    expect(tokens).toBeGreaterThan(0);
    expect(netUsd).toBeGreaterThan(0);
  });

  it("never books count_tokens, however often it is called", async () => {
    for (let i = 0; i < 3; i++) await (await post("/v1/messages/count_tokens")).text();
    expect(addSaving).not.toHaveBeenCalled();
    expect(addRequest).not.toHaveBeenCalled();
  });

  it("does not book a request the upstream rejected", async () => {
    upstreamStatus = 529;
    const resp = await post("/v1/messages");
    expect(resp.status).toBe(529);
    await resp.text();
    expect(addSaving).not.toHaveBeenCalled();
    expect(addRequest).not.toHaveBeenCalled();
  });

  it("passes a negative net estimate through when a fold cost more than it saved", async () => {
    // A huge summarize output makes the ScaleDown call cost exceed the
    // Anthropic-side tokens it avoided.
    summaryOutputChars = 50_000_000;
    await (await post("/v1/messages")).text();
    expect(addSaving).toHaveBeenCalledTimes(1);
    const [, tokens, netUsd] = addSaving.mock.calls[0] as [string, number, number];
    expect(tokens).toBe(0);
    expect(netUsd).toBeLessThan(0);
  });
});
