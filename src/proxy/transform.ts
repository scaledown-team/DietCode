// Progressive compaction for the DietCode proxy.
//
// The key property: we do NOT summarize on every request. We keep a per-session
// "running summary" standing in for the oldest turns, plus a verbatim "hot
// window" of everything since. Most requests just forward (summary + hot
// window) with zero ScaleDown calls. A compaction step — one ScaleDown call
// that folds the older part of the hot window into the running summary — fires
// when EITHER (summary + hot window) exceeds `compactThreshold` (a safety net
// for a single turn that dumps a huge tool result) OR `foldEveryTurns` new
// turns have accumulated since the last fold (a steady cadence that keeps
// stale/duplicate tool output — repeated file reads, re-run commands — from
// sitting in the live window for long). `state.agedThrough` is the boundary:
// everything at or before it has already been folded into `runningSummary` by
// ScaleDown; only messages after it are live and eligible for the next fold.
// Deduplicating repeated tool output is instructions to ScaleDown's summarize
// call (see SUMMARY_INSTRUCTIONS below), not separate local logic — the fold
// input already contains every duplicate, and the model is told to collapse
// them itself.
//
// Cache safety: `system`, `tools`, and the verbatim tail are never modified.
// The folded summary block is byte-identical between compaction steps (it is
// derived from fixed history), so Anthropic's prompt cache keeps hitting; it
// changes only at a compaction step, exactly when native compaction would have
// busted the cache too. When the summary is large enough to be cacheable, we
// also mark it as an explicit cache_control breakpoint (see
// `countCacheControlBreakpoints` / `addCacheControl` below) so it's a cheap
// cache read instead of full reprocessing on every request in between folds.

import { estimateTokens } from "../niah.js";
import type { ProxyConfig } from "../config.js";
import { putOriginal, type SessionState } from "./store.js";

export interface AnthropicMessage {
  role: string;
  content: unknown; // string | ContentBlock[]
}

export interface MessagesBody {
  messages?: AnthropicMessage[];
  system?: unknown;
  tools?: unknown;
  [k: string]: unknown;
}

export interface TransformDeps {
  /** Injected so tests can run without a live ScaledownClient. */
  summarize: (text: string, instructions?: string) => Promise<string>;
}

export interface TransformResult {
  body: MessagesBody;
  savedTokens: number;
  state: SessionState;
  /** True iff a ScaleDown call happened on this request (a compaction step). */
  compacted: boolean;
}

const SUMMARY_INSTRUCTIONS =
  "Summarize this software-engineering conversation concisely, preserving key " +
  "decisions, code changes, exact file paths, commands, error messages, and any " +
  "context needed to continue the work seamlessly. Merge any existing summary " +
  "and the new turns into a single cohesive summary. When a tool result " +
  "(reading a file, running a command, searching) appears more than once for " +
  "the same file or command — e.g. a file read, then edited, then read again — " +
  "keep only the most recent/relevant version and drop the earlier redundant " +
  "copies entirely rather than describing them.";

// Anthropic caches the request prefix ending at a cache_control breakpoint;
// below this size it silently declines to cache, so don't spend a breakpoint
// slot on a summary too small to benefit (Sonnet/Opus minimum; conservative
// for Haiku too).
const MIN_CACHEABLE_TOKENS = 1024;
// Anthropic allows at most 4 cache_control breakpoints per request.
const MAX_CACHE_BREAKPOINTS = 4;

// A "user prompt" is a real user turn — role user with no tool_result block.
// These are the only safe boundaries to cut at: cutting elsewhere could orphan a
// tool_result from its tool_use and make Anthropic reject the request.
function isUserPrompt(msg: AnthropicMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return true;
  if (Array.isArray(msg.content)) {
    return !msg.content.some(
      (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result"
    );
  }
  return true;
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  if (b.type === "text" && typeof b.text === "string") return b.text;
  if (b.type === "tool_use") {
    const name = typeof b.name === "string" ? b.name : "tool";
    return `[tool_use: ${name}(${JSON.stringify(b.input ?? {})})]`;
  }
  if (b.type === "tool_result") {
    const c = b.content;
    if (typeof c === "string") return `[tool_result] ${c}`;
    if (Array.isArray(c)) return `[tool_result] ${c.map(blockText).join("\n")}`;
    return "[tool_result]";
  }
  if (typeof b.text === "string") return b.text;
  return "";
}

function messageText(msg: AnthropicMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map(blockText).filter(Boolean).join("\n");
  return "";
}

function serialize(messages: AnthropicMessage[]): string {
  return messages
    .map((m) => {
      const t = messageText(m).trim();
      return t ? `${m.role.toUpperCase()}:\n${t}` : "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function normalizeContent(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return [];
}

// Index of the message that leaves the last `recentTurns` user prompts (and
// everything after them) verbatim. Returns -1 if there aren't enough turns to
// compact anything.
function foldBoundary(messages: AnthropicMessage[], recentTurns: number): number {
  const userIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isUserPrompt(messages[i])) userIdxs.push(i);
  }
  if (userIdxs.length <= recentTurns) return -1;
  return userIdxs[userIdxs.length - recentTurns];
}

function buildPreamble(summary: string, retrieveId: string): string {
  return (
    "[Earlier conversation — ScaleDown summary. " +
    `Call sd_retrieve("${retrieveId}") for the full earlier transcript.]\n\n` +
    summary +
    "\n\n[End of summary — recent turns continue below.]"
  );
}

// Counts existing cache_control breakpoints in a `system` or `tools` array
// (the only places besides messages Anthropic allows them, and the only two
// this proxy never rewrites, so the count is stable request to request).
function countCacheControlBreakpoints(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0;
  return blocks.filter(
    (b) => b && typeof b === "object" && "cache_control" in (b as Record<string, unknown>)
  ).length;
}

// Folds the running summary into the first kept message (a user prompt) so the
// forwarded message list stays role-valid (no extra/duplicate-role messages).
// When `addCacheControl` is set, the injected summary block is marked as an
// ephemeral cache_control breakpoint: it's byte-identical between compaction
// steps, so it's a cheap cache read on every request until the next fold.
function applySummary(
  messages: AnthropicMessage[],
  state: SessionState,
  retrieveId: string,
  addCacheControl: boolean
): AnthropicMessage[] {
  if (!state.runningSummary || state.agedThrough <= 0) return messages;
  const anchor = messages[state.agedThrough];
  if (!anchor) return messages;
  const preambleBlock: Record<string, unknown> = {
    type: "text",
    text: buildPreamble(state.runningSummary, retrieveId),
  };
  if (addCacheControl) preambleBlock.cache_control = { type: "ephemeral" };
  const folded: AnthropicMessage = {
    role: "user",
    content: [preambleBlock, ...normalizeContent(anchor.content)],
  };
  return [folded, ...messages.slice(state.agedThrough + 1)];
}

export async function transformRequest(
  body: MessagesBody,
  state: SessionState,
  config: ProxyConfig,
  deps: TransformDeps
): Promise<TransformResult> {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { body, savedTokens: 0, state, compacted: false };
  }

  // Defensive: if history shrank below where we'd aged to (new/forked
  // conversation reusing the id), reset rather than fold against a bad index.
  let working: SessionState =
    state.agedThrough > messages.length ||
    (state.agedThrough > 0 && !isUserPrompt(messages[state.agedThrough] ?? { role: "x", content: "" }))
      ? { runningSummary: "", agedThrough: 0, updatedAt: "" }
      : { ...state };

  let compacted = false;
  let retrieveId = state.runningSummary ? putOriginal(state.runningSummary, state.runningSummary) : "";

  // Decide whether this request needs a compaction step: either the live
  // window has crossed the token budget (safety net), or foldEveryTurns new
  // turns have piled up since the last fold (steady cadence — see file header).
  const liveTokens =
    estimateTokens(working.runningSummary) +
    estimateTokens(serialize(messages.slice(working.agedThrough)));

  const boundary = foldBoundary(messages, config.recentTurns);
  const newTurns =
    boundary > working.agedThrough
      ? messages.slice(working.agedThrough, boundary).filter(isUserPrompt).length
      : 0;

  if (boundary > working.agedThrough && (liveTokens > config.compactThreshold || newTurns >= config.foldEveryTurns)) {
    const newlyAged = messages.slice(working.agedThrough, boundary);
    const input = working.runningSummary
      ? `[Existing summary]\n${working.runningSummary}\n\n[New turns]\n${serialize(newlyAged)}`
      : serialize(newlyAged);
    try {
      const summary = await deps.summarize(input, SUMMARY_INSTRUCTIONS);
      if (summary && summary.trim()) {
        // Store the full aged transcript for sd_retrieve reversibility.
        retrieveId = putOriginal(serialize(messages.slice(0, boundary)), summary);
        working = { runningSummary: summary, agedThrough: boundary, updatedAt: "" };
        compacted = true;
      }
    } catch {
      // Fail-open: keep the prior state, forward without a new summary.
    }
  }

  const addCacheControl =
    !config.cacheControlDisable &&
    !!working.runningSummary &&
    estimateTokens(working.runningSummary) >= MIN_CACHEABLE_TOKENS &&
    countCacheControlBreakpoints(body.system) + countCacheControlBreakpoints(body.tools) <
      MAX_CACHE_BREAKPOINTS;

  const forwarded = applySummary(messages, working, retrieveId, addCacheControl);
  const savedTokens = Math.max(
    0,
    estimateTokens(JSON.stringify(messages)) - estimateTokens(JSON.stringify(forwarded))
  );

  return {
    body: { ...body, messages: forwarded },
    savedTokens,
    state: working,
    compacted,
  };
}
