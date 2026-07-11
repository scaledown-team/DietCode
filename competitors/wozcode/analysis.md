# WOZCODE — Competitor Analysis

**Repo:** [`WithWoz/wozcode-plugin`](https://github.com/WithWoz/wozcode-plugin) · **Site:** wozcode.com · **App:** app.wozcode.com
**Analyzed at:** commit cloned 2026-07-11 (bundle version 0.3.86).

**One-line pitch (theirs):** "Smarter tools for Claude Code that reduce token usage and cost. Replaces built-in file tools with optimized alternatives." Marketed as 80% on TerminalBench 2.0, 5–10x faster, 25–55% cheaper than vanilla Claude Code.

**What it actually is, in one sentence:** a Claude Code plugin that (1) forces the agent onto three custom MCP tools (real local Search/Edit/Sql engines) instead of the built-ins, (2) runs a local LLM-routing daemon that can transparently substitute Claude's own backend with OpenAI, AWS Bedrock, Azure, or — via header-spoofed impersonation of Codex CLI — a ChatGPT subscription, and (3) bundles a separate, opt-in AI code-review product ("WozPairProgrammer") backed by a knowledge base that, once enabled, uploads real source file content to a Woz-operated server by default. It is a fundamentally different kind of "efficiency" product than RTK or Headroom: a meaningful share of its cost/speed story comes from swapping the underlying model, not from compressing tokens.

---

## 0. Methodology — how this was analyzed

Unlike RTK and Headroom, WOZCODE's distributed code is **deliberately obfuscated**, not merely minified. Every `.js` file in `chunks/`, `scripts/`, `servers/`, and `standalone/` (59MB across 122 chunk files alone) is run through **`javascript-obfuscator`** (confirmed directly — `javascript-obfuscator ^5.4.3` appears in the project's own `devDependencies`, recovered from a bundled `package.json`) on top of an esbuild bundle: hex-named variables (`_0x50af`), a rotating base64/hex string-array with a decoder function resolved at runtime, and a self-defending IIFE.

**Deobfuscation pipeline used:**
1. `npm install webcrack prettier js-beautify` — `webcrack` is a purpose-built tool for reversing exactly this obfuscator's output (string-array decoding, dead-code elimination, control-flow un-flattening) and for un-bundling esbuild/webpack output.
2. `npx webcrack <file.js> -o <outdir>` per file — recovers real control flow and **all string literals in plaintext** (error messages, API endpoints, config keys, tool names, schema fields). Local variable/function names remain meaningless `_0x...` hex (webcrack cannot recover identifiers that were never in the source it's un-scrambling), so intent has to be inferred from string literals, call shape, and cross-referencing which functions get imported where — the same way one would read a stripped binary.
3. All 19 entry-point scripts in `scripts/`, plus `servers/code-server.js` (the MCP tool server, 1.7MB) and ~15 of the ~122 shared `chunks/*.js` files that those entry points import from, were deobfuscated this way and read in full or via targeted search for tool-definition/schema/URL patterns.
4. One file, `standalone/savings-check.js`, turned out to **not be obfuscated at all** (`javascript-obfuscator` was skipped for it at build time — confirmed via the project's own `build:claude` vs `build:claude:prod --no-obfuscate` npm scripts) and retains original esbuild source comments (`// src/common/baseline/baseline-scanner.ts`) — this is the cleanest window into the real source tree structure available anywhere in the repo.
5. Plaintext, non-obfuscated files that needed no deobfuscation at all — `agents/*.md`, `skills/*/SKILL.md`, `hooks/hooks.json`, `.mcp.json`, `settings.json`, `scripts/router-config.jsonc`, `README.md` — turned out to carry an enormous amount of the real information density on their own (agent tool allow/deny-lists, the full LLM-router provider configuration, MCP server wiring) and were read directly.

Every claim below is anchored to a specific string literal, schema shape, file path, or config value actually observed in the deobfuscated output or plaintext files — not inferred from variable naming, which carries no signal. Two things are explicitly flagged as unconfirmed where the evidence ran out (the 7 reviewer persona names/prompts; the exact payload consumers of `api.wozcode.com` outside the KB-ingest endpoint) rather than guessed.

---

## 1. Architecture

WOZCODE installs as a Claude Code plugin (also built for Codex CLI and GitHub Copilot — `codex/` and presumably a `copilot/` build variant ship in the repo, and the recovered `package.json` has parallel `build:claude`/`build:codex`/`build:copilot` npm scripts) plus an optional native desktop app (built with `electrobun`, a menu-bar tray).

**Three Claude Code agents ship in `agents/`:**
- **`woz:code`** (`agents/code.md`) — the default main-thread agent. `disallowedTools: Read, Edit, Write, Grep, Glob, NotebookEdit` — every one of Claude Code's built-in file tools is explicitly turned off, forcing all file interaction through WOZCODE's own MCP tools.
- **`woz:code-free`** (`agents/code-free.md`) — the fallback agent, active "when the monthly free-plan cap is exhausted." Inverts the above: built-in Read/Edit/Write/Grep/Glob/NotebookEdit are restored, and `disallowedTools: mcp__plugin_woz_code__Search, mcp__plugin_woz_code__Edit, mcp__plugin_woz_code__Sql` — WOZCODE's own tools are cut off until the cap resets or the user upgrades. This confirms WOZCODE is a metered SaaS product with a free tier, not a purely local tool.
- **`woz:explore`** (`agents/explore.md`) — a haiku-powered, read-only subagent for fast lookups (`tools: mcp__plugin_woz_code__Search, mcp__plugin_woz_code__Sql, Bash`), auto-delegated to by `woz:code`. Its system prompt is itself a token-discipline exercise: dense line-per-finding output format, explicit "no preamble, no narration," and instructions to batch parallel searches — conceptually similar to how DietCode's own intent-classification hint tries to route the agent to the cheap path without hand-holding.

**MCP server**: `.mcp.json` registers one server, `code`, running `servers/code-server.js`, `alwaysLoad: true` by default (loads all tool schemas up front rather than deferring behind Claude Code's `ToolSearch`). It exposes **six tools**, not the four the README advertises:

| Tool | Read-only? | Notes |
|---|---|---|
| `Search` | yes | replaces Grep/Glob/Read-for-search |
| `Edit` | no | replaces Edit/Write/NotebookEdit |
| `Sql` | no (executes queries) | live database introspection/querying |
| `Recall` | yes | semantic search over past session transcripts |
| `Browser` | no, `openWorldHint:true` | Playwright-over-CDP browser automation — **Cowork-only** (WOZCODE's own agent-orchestration product, gated, undocumented in the public README) |
| `WozCLI` | — | host-side login/logout/status/settings — **Cowork-only** |

**PreToolUse/PostToolUse hooks** (`hooks/hooks.json`) wire `scripts/session-hook.js` into `SessionStart`, `UserPromptSubmit`, `PreToolUse` (all tool calls, no matcher), and `StopFailure`; `scripts/reviewer-hook.js` into `PostToolUse` matched specifically on `mcp__plugin_woz_code__Edit`; and `scripts/session-telemetry-hook.js` into `PostToolUse` (catch-all), `SubagentStop`, `Stop`, `PreCompact`, and `PostCompact` — telemetry fires on almost every Claude Code lifecycle event.

---

## 2. The Bash-redirection hook — nudging, not blocking

`scripts/session-hook.js`'s `PreToolUse` handler (function `yr`/`Q` in the deobfuscated output) is the mechanism that makes `woz:code`'s tool-lockout actually work in practice, since the agent could otherwise just reach for `Bash` to read/search/edit/query a database. It maintains regex tables for command families:

```
Kt = /^(cat|sed)\s/                                       -> "use Search instead"
jt = /^(head|tail|less|more)\b/                           -> "use Search instead" (when a real path arg is present)
Yt = /^(grep|rg|ack|ag|find|awk|bfs|ugrep|ug)\s/           -> "use Search instead"
Qt = /^ls(\s|$)/                                           -> "use Search instead"
Ot = /^(sed\s+-i|cat\s*>|cat\s*<<|echo\s.*>|printf\s.*>)/  -> "use Edit instead"
er = /^(psql|pg_dump|pg_restore|mysql|sqlite3)\b/          -> "use Sql instead"
kt = /^node\s+-e\s+.*(writeFile|appendFile|createWriteStream)/  -> "use Edit instead"
```
with allowlists for legitimate Bash uses (`tsc`, test runners, `git`, `docker`, `kubectl`, build tools, shell control-flow keywords) that are never redirected. Compound commands are stripped of `$()`/backtick substitutions and split on `&&`/`||`/`;`/pipes before matching, mirroring the shell-parsing rigor seen in RTK's own hook (see `competitors/rtk/analysis.md` §2.1) — worth noting as a case of two unrelated products converging on the same defensive parsing approach for the same underlying problem (safely classifying an arbitrary shell command line).

Critically, **the hook never returns a `deny` decision** — every match returns `permissionDecision: "allow"` with `additionalContext` carrying a scolding reminder ("IMPORTANT: this command was allowed to run, but you MUST use the correct tool for all subsequent calls"). It's a steering nudge injected into the model's context, not a hard block — the same pattern used in the router config's system-prompt rewrites for Codex/GPT-5.x (see §3) and structurally similar to RTK's `Ask`/`Defer` distinction, except WOZCODE always lets the command through and relies on the injected text to change the model's next move.

The same hook also handles **subagent redirection**: it intercepts `Task`/`Agent` calls that request Claude Code's built-in `Explore` subagent type and silently rewrites them to WOZCODE's own `woz:explore` (and vice versa, if WOZCODE's tools are unusable for the session) — with the rewrite reason injected back as `additionalContext` and reported to PostHog as a `subagent_redirect_rewritten` event.

---

## 3. The router daemon — silent model substitution

This is the single most consequential architectural fact about WOZCODE, and it is **not mentioned anywhere in the public README**. `scripts/router-daemon.js` is a full lifecycle CLI (`start`/`stop`/`restart`/`status`/`refresh`/`activate <backend>`/`foreground`) for a local LLM-routing proxy, configured by `scripts/router-config.jsonc` (fully plaintext, no deobfuscation needed — read in full).

**What it does**: it runs a local HTTP server that Claude Code's `ANTHROPIC_BASE_URL` can be pointed at, and re-routes outbound requests to one of several configured backends, remapping Claude's own tier names (`haiku`/`sonnet`/`opus`) to a target model on a completely different provider:

```jsonc
"openai": { "modelMappings": [
  { "model": "*haiku*", "target": "gpt-5.4-mini" },
  { "model": "*sonnet*", "target": "gpt-5.4" },
  { "model": "*opus*",   "target": "gpt-5.5" }
]}
```

Configured providers include: direct OpenAI (`api.openai.com`), Meta ("Muse Spark," `api.meta.ai`), AWS Bedrock Mantle (serving DeepSeek V3.2, Kimi K2.5/2.6, MiniMax M2.1, GLM 4.6/4.7, and Claude itself via Bedrock), Azure AI Foundry, a local `llamacpp` instance, and native Anthropic passthrough. Routing presets are addressable as `/router-preset<path>/v1/...` — `/claudecode` (Anthropic passthrough, the default), `/claudecode-chatgpt`, `/claudecode-azure`, `/codex`, `/codex-azure`.

**The most notable provider is `chatgpt`** — routing Claude Code's traffic through a **ChatGPT Plus/Pro subscription** via `~/.codex/auth.json` (the same OAuth token `codex login` produces), disguised as genuine Codex CLI traffic to OpenAI's backend-api gateway:

```jsonc
"backend": "chatgpt-oauth",
"baseUrl": "https://chatgpt.com/backend-api/codex/",
"requestModifications": [{
  "systemPrompt": [{ "type": "prepend", "text": "${CODEX_CLI_SYSTEM_PROMPT_PREFIX}" }],
  "cookieJar": "cloudflare",
  "headers": [
    { "type": "remove", "name": "anthropic-*" },
    { "type": "remove", "name": "x-app" },
    { "type": "remove", "name": "x-claude-code-session-id" },
    { "type": "remove", "name": "x-stainless-*" },
    { "type": "add", "name": "user-agent", "value": "codex_cli_rs/0.32.0" },
    { "type": "add", "name": "originator", "value": "codex_cli_rs" }
  ],
  "body": [
    { "type": "remove", "path": "max_tokens" },
    { "type": "remove", "path": "metadata" },
    { "type": "remove", "path": "temperature" }
    // ...
  ]
}]
```

This strips every header that would identify the request as coming from Claude Code, adds the exact `User-Agent`/`originator` values a real Codex CLI would send, and prepends Codex CLI's own system-prompt prefix — i.e. it makes a Claude Code session's traffic indistinguishable from genuine Codex CLI traffic to OpenAI's own gateway, in order to draw against a ChatGPT subscription's Codex allowance rather than metered OpenAI API billing. There is a matching `codex-passthrough-chatgpt` provider explicitly documented in its own config comment as forwarding "the inbound ChatGPT bearer + `chatgpt-account-id` header verbatim." **This is worth flagging plainly**: this is header-spoofed client impersonation against a third party's authentication gateway to access a subscription tier at a cost the request's real origin wouldn't be entitled to bill against — a materially different (and likely ToS-violating, possibly account-risk-bearing-for-the-end-user) approach to "cost savings" than anything in RTK or Headroom, both of which only ever compress or route traffic between parties who already agreed to the traffic (the user's own configured API keys/subscriptions).

For non-Anthropic backends, the router also rewrites the receiving model's own system prompt and tool list to keep it from reaching for its native tools (`apply_patch` for Codex/GPT-5.x) and instead push it toward WOZCODE's MCP tools:

```jsonc
{ "type": "edit",
  "search": "- Use `apply_patch` for manual code edits...",
  "replace": "- Use mcp__plugin_woz_code__Edit for all file creation and code edits instead of `apply_patch`..." }
```

**Failure recovery**: `session-hook.js` also contains logic (`Ct`/`Rt`/`ht`) that detects two specific router-related failure signatures — a `thinking`-block signature error and a `model_not_found` error whose message references "selected model (...)" — and either surfaces a recovery instruction or auto-restarts the router daemon, depending on the `UserPromptSubmit`-time `cc-router` setting (`off`/`auto`).

**The reviewer's own LLM calls are wired through the same substitution path**: `reviewerBaseUrl` (settings) feeds directly into the `ANTHROPIC_BASE_URL` used for the reviewer persona `query()` calls (see §5) — so a routed WOZCODE install can have its code-review LLM calls silently running on GPT-5.x or Bedrock too, not just the interactive agent.

---

## 4. The three core file tools — genuinely re-engineered, not just relabeled

Contrary to a "thin wrapper around the same primitives" assumption, `Search`/`Edit`/`Sql` are real, independently-implemented engines with materially different capability surfaces than Claude Code's built-ins. All three run **fully in-process, with no calls to any Woz-operated server** for their core operation (confirmed by exhaustive `https://`/`fetch(` grep across each tool's chunk).

**`Search`** — a real local glob+regex engine (bundles the actual `glob`/`minimatch`/`path-scurry` npm packages, confirmed via internal error strings and class names), not a wrapper around shelling out to `ripgrep`/`grep` (no `child_process` calls found anywhere in its chunk). `content_regex` compiles to a native `RegExp` with full regex semantics; `file_glob_patterns` do real glob matching; output modes include `file_paths_with_match_count`/`file_paths_with_content`/summary; supports `#N-M` line-range suffixes and an `if_modified_since` filter. This is the same tool `agents/explore.md` instructs the haiku subagent to lean on instead of "the read-everything trap."

**`Edit`** — takes a **batch** of edits across potentially many files in a single call (`{cwd, edits: EditItem[]}`), applying them grouped-per-file (one read, N patches, one write) rather than the built-in Edit's one-call-per-patch model — this batching is the literal mechanism behind the "10 files, 2 calls instead of 9+" claim in WOZCODE's marketing. Beyond batching, it adds: **fuzzy matching** when an exact `old_string` fails (falls back to similarity matching, reporting e.g. "Applied via 87% similarity match" back to the model rather than hard-failing), rejection of ambiguous non-unique matches, and first-class **Jupyter notebook cell operations** (`insert_after`/`insert_before`/`delete`/`move_after`/`move_before` on cells by id, plus `cell_type`) that fully replace the built-in `NotebookEdit` tool rather than just wrapping it.

**`Sql`** — genuinely executes queries against live databases, it does not merely parse or validate SQL. Bundles the real `postgres` (porsager/postgres) and `mysql2` npm drivers plus Node's own built-in `node:sqlite`, opening real TCP/socket connections to whatever `connection_string` (or auto-discovered `.env`/`DATABASE_URL`) the caller supplies. Pre-flight linting and autofix (typo "did you mean" suggestions, auto-`LIMIT` insertion on unbounded `SELECT`s) is backed by a real **`libpg-query.wasm`** — the pganalyze/libpg_query Postgres AST parser compiled to WebAssembly — plus a process-local, never-persisted schema cache. Actions cover `tables`/`table`/`functions`/`enums`/`types`/`relationships`/`search`/`lint`/`query`/`connect`, and batches multiple named statements per call (`queries: {name, sql}[]`). This is the feature `agents/code.md`'s description calls "SQL introspection" and it is a real, distinctive capability — none of RTK, Headroom, or DietCode have an equivalent live-database tool.

**`Recall`** — semantic search over past Claude Code session transcripts, but the "semantic" search is **not** a call to an embeddings API. It's a local, hand-rolled lexical feature-hashing scheme: regex tokenization, camelCase/snake_case identifier splitting, `FUNC:`/`TYPE:` symbol extraction, weighted uni/bi/trigrams hashed into a fixed-dimension vector, compressed for storage ("TurboQuant" in the product's own naming), matched via in-process cosine similarity over a locally-streamed index — no network call, no external embedding provider. Indexing appears to run out-of-band (`scripts/recall-index-worker.js`, which reports only aggregate counts via telemetry, never transcript content), though `code-server.js` itself does not spawn that worker — the trigger for indexing wasn't conclusively traced.

---

## 5. WozPairProgrammer — the reviewer system, and the source-code-upload finding

This is a genuinely separate product bolted onto the same plugin: an AI code-review layer with two modes, both **off by default**:
- **Live reviewer** (`liveReviewer` setting, default `false`) — runs after every `mcp__plugin_woz_code__Edit` call.
- **Deep cadence reviewer** (`deepEditCountReviewer`, default `false`, interval `deepEditCountInterval=50`) — runs every N edits.
- **`/woz review`** — an on-demand deep pass: **7 narrow-lens personas run in parallel** (cross-file consistency, duplication/DRY, codebase-reuse, type-safety, SDK/library-type-reuse, correctness/edge-cases, comment/docs-hygiene — names taken from the plaintext `skills/woz/SKILL.md`), followed by a **sequential wide-lens cross-cutting pass** that consumes the narrow personas' findings as priors, each persona pre-fed knowledge-base context, personal-curation notes, and a relevant slice of `CLAUDE.md`.

Both live and deep modes additionally require `hasFreshKbAccess` — an org/paid entitlement gate — so the pathway is fully inert without both the setting *and* the subscription tier.

**Execution mechanism**: triggering spawns a fully detached, unref'd background Node child process (`spawn(..., {stdio:["pipe","ignore","ignore"], detached:true})`) — independent of the parent Claude Code session's lifetime, matching the product's own "running silently in the background" framing. The child runs persona review passes via the **Claude Agent SDK's `query()` API directly**, each persona scoped to a `search-only` MCP server reusing the same `Search` engine described in §4, `permissionMode: "bypassPermissions"`, and a default live-reviewer model of the literal string `"claude-sonnet-4-6"`.

**Auto-apply**: `"edit"`-type findings can be applied automatically with no user confirmation — literal old-string search (refuses if non-unique), patch-apply, raw file write. Safety checks include a repo-root containment check (via `realpath`) and a stale-mtime guard (skips if the target file changed since the finding was captured). The product's own banner text describes this as auto-applying "small CLAUDE.md fixes," but nothing in the actual apply function restricts the target path to `CLAUDE.md` specifically — any file in the repo can receive an auto-applied edit from an `"edit"`-type finding; whether the persona prompts self-restrict to CLAUDE.md-style changes wasn't verifiable from the code alone.

**The key finding — default remote knowledge-base upload**: three settings/config values chain together:
```js
knowledgeBaseProvider: "remote"                          // default
knowledgeBaseServerUrl: apiServiceUrl                     // resolves to https://api.wozcode.com
```
and the remote KB handle's `ingestFiles()` method:
```js
async ingestFiles(files) {
  let body = {
    scope: { type: "repo", orgId, repoFullName: this.repoFullName },
    files: files.map(f => ({ filePathRel: f.filePathRel, content: f.content, mtimeMs: f.mtimeMs }))
  };
  return await this.send("/v1/knowledge-base/ingest", { method: "POST", body }, ...);
}
```
sends **raw source file content** (`content: f.content`, not a hash or embedding) to `POST https://api.wozcode.com/v1/knowledge-base/ingest`, with a matching `GET /v1/knowledge-base/chunk/<id>` retrieval endpoint confirming the server stores and can return the content verbatim. This is triggered automatically: a "coverage-drift-reconcile" routine runs at the end of every live-reviewer pass (throttled to once per 5 minutes per repo), compares local file count to the remote index's file count, and if the remote lags by more than ~10% it reads the missing files from disk and uploads them — silently, with only a telemetry breadcrumb, no user-facing prompt.

A genuinely local alternative implementation exists (`knowledgeBaseProvider: "local"`, a separate class with no network I/O), so this is a **default**, not an inescapable behavior. But it means: for any organization that turns on the product's flagship differentiator (live/deep review), the out-of-the-box wiring uploads real source file content to a Woz-operated server — which is difficult to reconcile with the README/marketing framing that the plugin "does not proxy, intercept, or exfiltrate any data" and "has no server-side component that receives your source code." That claim is accurate for the base plugin with review features off, and separately accurate for the standalone `savings-check.js` script (see §7) — but not accurate for the product's own headline review feature once enabled.

`woz-kb.js` additionally exposes a PR-history-based **autotuner** (`woz-kb backtest --repo <owner/name>`, `woz-kb tune --repo ... [--apply]`) that clones real historical PRs into sandboxed, origin-stripped, push-blocked clones (`unreachable://` push URL rewrite, credentials stripped, `HOME` sandboxed — a real safety contract worth noting as sound engineering), runs the reviewer against them blind, and scores recall/precision against the actual human review comments on those PRs to calibrate the knowledge base.

---

## 6. Telemetry, auth, and billing

**Auth**: browser OAuth, API-key (`woz_sk_...`), or token login, backed by a self-hosted **Supabase** project at `https://builder.withwoz.com` (with a hardcoded publishable anon key baked into the client bundle — standard practice for Supabase's public/anon key model, not itself a vulnerability). `wozcode-cli.js login/logout/status` are thin wrappers over this. Feedback/bug reports (`/woz-feedback`) genuinely POST to a Supabase Edge Function (`wozcode/feedback/submit`) carrying subject/body/email/platform/OS/Node version/session id/anonymous id.

**Telemetry**: the real **PostHog Node SDK** is bundled, with a live project token hardcoded directly into `.mcp.json` (`WOZCODE_POSTHOG_ENABLED=true`, `WOZCODE_POSTHOG_PROJECT_TOKEN=phc_F3mo2emdspgzD4QmFMQxHQfab1TyXgCAU7eYBakKq9k`), firing to `https://us.i.posthog.com` or `https://eu.i.posthog.com` (region selectable) on nearly every hook lifecycle event and every MCP tool call (`tool_called`, `tool_error`, `search_stats`, `sql_action`, `edit_tool_call`, `session_usage_update`, `session_completed`, `compaction_started/finished`, `subagent_redirect_rewritten`, and more). Payloads observed are metadata-only in every call site checked — token counts, cost, turn/tool-use counts, session/user IDs, error codes/stacks, timing — never file content, query text, or diffs in the MCP-tool-call telemetry specifically (contrast the KB-upload pathway in §5, which is a separate channel that does carry content). An `identify()` call binds the anonymous telemetry ID to the logged-in user's real ID and email once authenticated.

**The literal basis for the "calls saved" marketing metric**: `session-telemetry-hook.js` computes `equivalent_claude_calls` — a reconstruction of how many raw built-in-tool round-trips a given batched WOZCODE tool call would have taken — versus `total_woz_calls`, and reports the delta (`calls_saved`) and `cost_saved_in_usd` per session and cumulatively. `scripts/edit-batching-nudge.js` is a small companion PostToolUse hook that tracks recent single-file `Edit` calls in a rolling window and, once several land in quick succession, injects a nudge coaching the model toward batching them — i.e. part of the "savings" the product reports is a number it also actively steers the model toward producing.

**The status line** (`savings-status-line.js`) rotates through roughly 7 message slots — savings stats, reviewer status, baseline comparison, a tip, lifetime savings, a free-trial nudge, and a referral-share prompt — weighted so upsell/referral messages appear interleaved with real usage stats on a roughly 1-in-6 basis.

**Attribution hijacking**: per the plaintext README, WOZCODE installs its own commit/PR co-author attribution line in `~/.claude/settings.json`, replacing Claude Code's built-in default, whenever no existing attribution entry is present — announced once, and left alone for users who'd already customized Claude Code's own attribution. Toggleable via `/woz-settings attribution off`.

---

## 7. The benchmark harness — how the marketing numbers are actually generated

`scripts/benchmark.js` (invoked via `/woz benchmark`) is a genuine two-real-session comparison harness, not a synthetic estimate generator:

1. **Real repo state**: clones the target repo at a pinned commit SHA (`git init` + `git remote add` + `git fetch --depth 1 origin <sha>` + `git checkout --detach`, cached by config hash) and runs any configured environment-setup shell commands.
2. **Real CLI subprocesses per comparison column**: spawns the actual `claude` (or `codex`) executable per prompt, once as "vanilla" (no plugin) and once with `--plugin-dir <path> --agent <wozcode-agent>`, feeding the prompt via `stream-json` over stdin and parsing the CLI's own streamed events back out.
3. **Vendor-reported metrics, not independently computed ones**: pulls `total_cost_usd`, `duration_ms`, token breakdowns, and `num_turns` directly from the CLI's own final `result` event — WOZCODE is reporting the tool's self-reported numbers, cross-checked against an independent re-scan of the session transcript (flagging and excluding any run where the two disagree by more than 15%, a real correctness guard).
4. **Quality is judged too, not just cost**: a separate LLM-as-judge pass (`claude-haiku-4-5-20251001`, single turn, no tools) scores each column's actual diff/output 0-10 on correctness/completeness/code-quality/avoids-overengineering.
5. **Caveat worth flagging explicitly**: when the benchmark plan requests a routed (non-Anthropic) model, the WOZCODE column runs through the router daemon against whatever backend is configured — meaning some fraction of a given "X% cheaper" result can reflect a cheaper underlying model substitution (§3) rather than tool-call efficiency, and nothing in the harness output separates the two effects.

This is legitimate, real-session benchmarking methodology (with an honest integrity check built in) applied to a comparison that isn't always apples-to-apples once routing is involved — worth taking the headline percentages seriously as measurements while being precise about what's actually varying between the two columns.

---

## 8. Network surface — full map

| Host / endpoint | Confirmed via | What flows there |
|---|---|---|
| `https://builder.withwoz.com` (Supabase) | `chunk-4KCKHHLQ.js` default `supabaseUrl` | Auth/session, feedback submission (`functions.invoke("wozcode/feedback/submit")`), session-stats upload from `session-telemetry-hook.js` |
| `https://api.wozcode.com` | `chunk-4KCKHHLQ.js` default `apiServiceUrl`; confirmed live endpoint `/v1/knowledge-base/ingest`, `/v1/knowledge-base/chunk/<id>`, `/v1/knowledge-base/reviewer-stats` | **Raw source file content** (when live/deep reviewer + remote KB provider are active — see §5); aggregate reviewer stats (no content) |
| `https://app.wozcode.com` | `chunk-4KCKHHLQ.js` default `appUrl` | Web dashboard / OAuth login redirect target |
| `https://us.i.posthog.com` / `https://eu.i.posthog.com` | `.mcp.json` project token + region setting, `chunk-4KCKHHLQ.js` | Usage/error telemetry, metadata-only (see §6) |
| `https://chatgpt.com/backend-api/codex/` | `router-config.jsonc` `chatgpt` provider | Claude Code traffic, header-spoofed as Codex CLI, billed against the user's ChatGPT subscription (§3) |
| `https://api.openai.com/v1/`, `https://api.meta.ai/v1/`, `https://bedrock-mantle.${AWS_REGION}.api.aws/`, `https://${FOUNDRY_RESOURCE_NAME}.openai.azure.com/`, `https://api.anthropic.com` | `router-config.jsonc` | Model-routing targets when the router daemon is active |
| `https://api.cursor.com/v1/` | `router-config.jsonc`, own comment: "pricing-only entry for cost lookups on Cursor transcripts" | Cost-table lookups only, not live inference |
| `https://wozcode.com` | share/referral message, `savings-check.js` footer | Referral/acquisition links, UTM-tagged (`?ref=savings-check`) |
| `https://github.com/WithWoz/wozcode-plugin.git` | `wozcode-cli.js`, `marketplace.json` | Plugin distribution/update via `claude plugin marketplace` |
| `https://sentry.io/organizations/` | string literal in bundled vendor code | No live call site found reachable from any executed path — appears to be inert vendored SDK code, not active |

**On the "no server-side component / doesn't exfiltrate data" claim**: accurate for `standalone/savings-check.js` specifically — that script's own banner ("No network calls. No writes. No telemetry.") was verified true for its actual `main()` code path. **Not accurate for the installed plugin as a whole**: usage telemetry (metadata only) flows to Supabase and PostHog on nearly every lifecycle event by default, and — the more consequential fact — the flagship review feature, once a user or org turns it on, uploads real source file content to `api.wozcode.com` by default. None of this appears to be malicious or concealed in a technical sense (it's real product functionality, and a local-only KB mode exists as an opt-out), but the blanket marketing claim doesn't hold once the product's own headline feature is switched on.

---

## 9. Distribution

Ships for **three coding-agent hosts** from one build pipeline: Claude Code (this plugin), Codex CLI (`codex/wozcode/`, a nearly-parallel file tree — separate `chunks/`, own `hooks/hooks.json`, own `.codex-plugin/plugin.json`), and GitHub Copilot (referenced in build scripts and in `session-hook.js`'s per-host `dr` object, `{claude, codex, copilot}`). A native desktop app (menu-bar tray, `electrobun`-based, `react`/`react-dom` webview) manages the background router/reviewer daemons outside any single coding-session's lifetime and is auto-offered for installation on first `SessionStart` if not already present. Native platform binaries ship for the `Sql` tool's Postgres AST parsing (`libpg-query.wasm`) and for terminal/PTY control (`node-pty`, `@lydell/node-pty`, `@homebridge/node-pty-prebuilt-multiarch` prebuilt across platforms) backing a "co-drive" feature (`scripts/codrive.js` — lets a separate shell attach to and drive a live `claude` TUI session over a local Unix-socket IPC protocol) and a headless-PTY prompt-injection tool (`scripts/claude-tui-cli.js`) used by the benchmark harness to script the real interactive TUI. Tree-sitter grammars ship as `web-tree-sitter` WASM (not native `.node` addons) for C/C++/Go/Java/Python/Rust — backing post-edit `syntaxValidation` warnings in the `Edit` tool.

---

## 10. How this differs from RTK, Headroom, and DietCode — implications

WOZCODE occupies a genuinely different point in the design space than the other two competitors analyzed:

- **RTK and Headroom compress; WOZCODE substitutes and batches.** Neither RTK's shell-output compaction nor Headroom's context-compression pipeline ever changes which model answers the prompt. A meaningful share of WOZCODE's advertised savings can come from routing "Claude" traffic to a cheaper non-Anthropic model (or a subscription billed to a different party) via the router daemon — a different lever entirely, with different risk (model-quality variance the user may not be aware of, and in the ChatGPT-impersonation case, real ToS/account exposure) than anything DietCode does. **This is worth being explicit about in any DietCode positioning**: DietCode's compression claims and WOZCODE's cost claims are not measuring the same thing, and a head-to-head "cheaper than WOZCODE" comparison would need to control for whether WOZCODE's comparison run involved a model swap.
- **The Bash-redirection "nudge, never deny" pattern** (§2) is a clean, low-friction alternative to RTK's harder permission-gating (RTK can genuinely block/ask) — worth considering for DietCode if it ever wants to steer the agent toward `sd_compress`/proxy-mode paths from a `PreToolUse` hook rather than only reactively compressing `PostToolUse` output.
- **The three re-engineered file tools (§4) are a legitimate, separate value proposition from token compression** — batched multi-file edits, fuzzy old-string matching, notebook-cell operations, and a real live-SQL tool are capability improvements, not efficiency tricks, and they're the part of WOZCODE's pitch least entangled with the model-substitution and data-upload issues raised above. If DietCode ever wants to compete on "fewer round trips" rather than "fewer tokens per round trip," this is the shape of feature to study.
- **The default-remote-KB-upload finding (§5) is the sharpest cautionary lesson here.** It's a concrete example of a product's own marketing claim ("no server-side component that receives your source code") becoming false the moment a headline feature is switched on, apparently without the wiring being surfaded prominently to the user at that moment (no user-facing prompt on the ingest path, only a telemetry breadcrumb). Any DietCode feature that might someday process code server-side (e.g. a hosted variant of Scaledown's compression/summarization) should treat "does this claim still hold with every optional feature turned on" as an explicit release-gate question, not an implicit one.
- **The real dual-session benchmark harness (§7) is a strong practice worth emulating** for validating DietCode's own savings claims — actually running two real Claude Code sessions against the same pinned repo state and prompt, cross-checking self-reported metrics against an independent transcript re-scan, and layering in an LLM-judge quality score rather than reporting cost/speed deltas alone.
