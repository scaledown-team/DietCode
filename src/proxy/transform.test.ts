import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { transformRequest, type MessagesBody } from "./transform.js";
import type { SessionState } from "./store.js";
import type { ProxyConfig } from "../config.js";

// putOriginal/saveSessionState touch ~/.scaledown — sandbox HOME.
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(resolve(tmpdir(), "dietcode-transform-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const baseConfig: ProxyConfig = {
  port: 8788,
  upstream: "https://api.anthropic.com",
  recentTurns: 2,
  blockThreshold: 2000,
  compactThreshold: 90000,
  disable: false,
  blockCompress: false,
  foldEveryTurns: 3,
  cacheControlDisable: false,
};

const EMPTY: SessionState = { runningSummary: "", agedThrough: 0, updatedAt: "" };

function summarizeResult(summary: string, inputChars = 0, outputChars = 0) {
  return { summary, inputChars: inputChars || summary.length, outputChars: outputChars || summary.length };
}

// 4 user prompts (idx 0,2,4,6) + assistants between.
function sampleMessages(): MessagesBody["messages"] {
  return [
    { role: "user", content: "u0 please do the first thing" },
    { role: "assistant", content: "a0 did the first thing" },
    { role: "user", content: "u1 now the second thing" },
    { role: "assistant", content: "a1 second done" },
    { role: "user", content: "u2 third thing" },
    { role: "assistant", content: "a2 third done" },
    { role: "user", content: "u3 latest request" },
  ];
}

function body(): MessagesBody {
  return {
    model: "claude-x",
    system: [{ type: "text", text: "SYSTEM PROMPT" }],
    tools: [{ name: "Bash" }],
    messages: sampleMessages(),
  };
}

describe("under the compaction threshold", () => {
  it("makes zero ScaleDown calls and leaves messages untouched when no summary exists", async () => {
    const summarize = jest.fn();
    const res = await transformRequest(body(), { ...EMPTY }, { ...baseConfig, compactThreshold: 1e9 }, {
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(res.compacted).toBe(false);
    expect(res.body.messages).toEqual(sampleMessages());
    expect(res.savedTokens).toBe(0);
  });

  it("reuses an existing running summary byte-for-byte (no ScaleDown call)", async () => {
    const summarize = jest.fn();
    const state: SessionState = { runningSummary: "EARLIER SUMMARY", agedThrough: 4, updatedAt: "" };
    const cfg = { ...baseConfig, compactThreshold: 1e9 };

    const r1 = await transformRequest(body(), state, cfg, { summarize });
    const r2 = await transformRequest(body(), state, cfg, { summarize });

    expect(summarize).not.toHaveBeenCalled();
    // Deterministic output across turns → prompt-cache stays warm.
    expect(JSON.stringify(r1.body)).toBe(JSON.stringify(r2.body));
    // Summary folded into the first kept message (the user prompt at idx 4).
    const first = r1.body.messages![0];
    expect(first.role).toBe("user");
    const text = (first.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("EARLIER SUMMARY");
    expect(text).toContain("sd_retrieve");
    // Tail preserved: folded msg + a2 + u3 == 3 messages.
    expect(r1.body.messages!.length).toBe(3);
  });
});

describe("at a compaction step (over threshold)", () => {
  it("calls summarize exactly once, folds the summary in, and advances state", async () => {
    const summarize = jest.fn().mockResolvedValue(summarizeResult("FRESH SUMMARY"));
    const res = await transformRequest(body(), { ...EMPTY }, { ...baseConfig, compactThreshold: 1 }, {
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(res.compacted).toBe(true);
    expect(res.state.agedThrough).toBe(4); // keeps last 2 user prompts (idx 4,6)
    expect(res.state.runningSummary).toBe("FRESH SUMMARY");

    const first = res.body.messages![0];
    const text = (first.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("FRESH SUMMARY");
  });

  it("asks ScaleDown to dedupe repeated tool output rather than describe it", async () => {
    const summarize = jest.fn().mockResolvedValue(summarizeResult("FRESH SUMMARY"));
    await transformRequest(body(), { ...EMPTY }, { ...baseConfig, compactThreshold: 1 }, { summarize });

    const instructions = summarize.mock.calls[0][1] as string;
    expect(instructions).toMatch(/redundant/i);
  });

  it("reports positive savings when the aged content is large", async () => {
    const summarize = jest.fn().mockResolvedValue(summarizeResult("TINY SUMMARY"));
    const big = "lorem ipsum ".repeat(500); // ~6k chars per message
    const heavy: MessagesBody = {
      messages: [
        { role: "user", content: `u0 ${big}` },
        { role: "assistant", content: `a0 ${big}` },
        { role: "user", content: `u1 ${big}` },
        { role: "assistant", content: `a1 ${big}` },
        { role: "user", content: "u2 short" },
        { role: "assistant", content: "a2 short" },
        { role: "user", content: "u3 short" },
      ],
    };
    const res = await transformRequest(heavy, { ...EMPTY }, { ...baseConfig, compactThreshold: 1 }, {
      summarize,
    });
    expect(res.compacted).toBe(true);
    expect(res.savedTokens).toBeGreaterThan(0);
  });

  it("extends the prior summary rather than starting over", async () => {
    const summarize = jest.fn().mockResolvedValue(summarizeResult("MERGED"));
    const state: SessionState = { runningSummary: "PRIOR", agedThrough: 2, updatedAt: "" };
    await transformRequest(body(), state, { ...baseConfig, compactThreshold: 1 }, { summarize });
    const input = summarize.mock.calls[0][0] as string;
    expect(input).toContain("PRIOR"); // existing summary fed back in
  });

  it("never touches system or tools", async () => {
    const summarize = jest.fn().mockResolvedValue(summarizeResult("S"));
    const b = body();
    const res = await transformRequest(b, { ...EMPTY }, { ...baseConfig, compactThreshold: 1 }, {
      summarize,
    });
    expect(res.body.system).toBe(b.system);
    expect(res.body.tools).toBe(b.tools);
  });
});

describe("fail-open", () => {
  it("forwards the original messages when summarize throws", async () => {
    const summarize = jest.fn().mockRejectedValue(new Error("scaledown down"));
    const res = await transformRequest(body(), { ...EMPTY }, { ...baseConfig, compactThreshold: 1 }, {
      summarize,
    });
    expect(res.compacted).toBe(false);
    expect(res.body.messages).toEqual(sampleMessages());
  });
});

describe("too few turns to compact", () => {
  it("does nothing when there aren't more than recentTurns user prompts", async () => {
    const summarize = jest.fn();
    const small: MessagesBody = {
      messages: [
        { role: "user", content: "only one" },
        { role: "assistant", content: "reply" },
      ],
    };
    const res = await transformRequest(small, { ...EMPTY }, { ...baseConfig, compactThreshold: 1 }, {
      summarize,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(res.compacted).toBe(false);
  });
});

describe("turn-cadence trigger", () => {
  // recentTurns=2, so sampleMessages() (4 user prompts) only has 2 foldable
  // turns — below foldEveryTurns=3 — even with a token threshold of ~0.
  it("does not fold before foldEveryTurns new turns have accumulated", async () => {
    const summarize = jest.fn();
    const res = await transformRequest(
      body(),
      { ...EMPTY },
      { ...baseConfig, compactThreshold: 1e9, foldEveryTurns: 3 },
      { summarize }
    );
    expect(summarize).not.toHaveBeenCalled();
    expect(res.compacted).toBe(false);
  });

  it("folds once foldEveryTurns new turns have accumulated, even under the token threshold", async () => {
    const summarize = jest.fn().mockResolvedValue(summarizeResult("CADENCE SUMMARY"));
    // 5 user prompts (idx 0,2,4,6,8); recentTurns=2 leaves 3 foldable turns.
    const many: MessagesBody = {
      messages: [
        { role: "user", content: "u0" },
        { role: "assistant", content: "a0" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
        { role: "user", content: "u4" },
      ],
    };
    const res = await transformRequest(
      many,
      { ...EMPTY },
      { ...baseConfig, compactThreshold: 1e9, foldEveryTurns: 3 },
      { summarize }
    );
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(res.compacted).toBe(true);
  });
});

describe("cache_control breakpoint on the folded summary", () => {
  const bigSummary = "lorem ipsum dolor sit amet ".repeat(200); // well over 1024 tokens

  it("adds an ephemeral cache_control breakpoint when the summary is large enough", async () => {
    const state: SessionState = { runningSummary: bigSummary, agedThrough: 4, updatedAt: "" };
    const res = await transformRequest(body(), state, { ...baseConfig, compactThreshold: 1e9 }, {
      summarize: jest.fn(),
    });
    const block = (res.body.messages![0].content as Array<Record<string, unknown>>)[0];
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });

  it("skips it when the summary is too small to be cacheable", async () => {
    const state: SessionState = { runningSummary: "short summary", agedThrough: 4, updatedAt: "" };
    const res = await transformRequest(body(), state, { ...baseConfig, compactThreshold: 1e9 }, {
      summarize: jest.fn(),
    });
    const block = (res.body.messages![0].content as Array<Record<string, unknown>>)[0];
    expect(block.cache_control).toBeUndefined();
  });

  it("skips it once the request already has 4 breakpoints", async () => {
    const state: SessionState = { runningSummary: bigSummary, agedThrough: 4, updatedAt: "" };
    const b = body();
    b.system = [{ type: "text", text: "SYSTEM PROMPT", cache_control: { type: "ephemeral" } }];
    b.tools = [
      { name: "A", cache_control: { type: "ephemeral" } },
      { name: "B", cache_control: { type: "ephemeral" } },
      { name: "C", cache_control: { type: "ephemeral" } },
    ];
    const res = await transformRequest(b, state, { ...baseConfig, compactThreshold: 1e9 }, {
      summarize: jest.fn(),
    });
    const block = (res.body.messages![0].content as Array<Record<string, unknown>>)[0];
    expect(block.cache_control).toBeUndefined();
  });

  it("respects cacheControlDisable", async () => {
    const state: SessionState = { runningSummary: bigSummary, agedThrough: 4, updatedAt: "" };
    const res = await transformRequest(
      body(),
      state,
      { ...baseConfig, compactThreshold: 1e9, cacheControlDisable: true },
      { summarize: jest.fn() }
    );
    const block = (res.body.messages![0].content as Array<Record<string, unknown>>)[0];
    expect(block.cache_control).toBeUndefined();
  });
});
