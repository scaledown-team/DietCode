# Headroom — Competitor Analysis

**Repo:** [`chopratejas/headroom`](https://github.com/chopratejas/headroom) · **PyPI:** `headroom-ai` · **npm:** `headroom-ai` · **License:** Apache 2.0
**Analyzed at:** commit cloned 2026-07-11 (v0.31.0), by cloning the repo locally and reading the full source: Python package (`headroom/`, ~40K LOC in `proxy/` alone, ~18K LOC in `transforms/`), Rust workspace (`crates/`, ~19K LOC in the proxy crate alone), TypeScript SDK (`sdk/typescript/`), plugins (`plugins/`), internal engineering docs (`REALIGNMENT/`, `wiki/`, `docs/`).

**Note on the folder name:** the user-facing product and repo are spelled **Headroom** (not "Headrom" — this analysis lives in `competitors/headrom/` to match the requested folder name).

**One-line pitch (theirs):** "Compress tool outputs, logs, files, and RAG chunks before they reach the LLM. 60-95% fewer tokens, same answers. Library, proxy, MCP server." 15,000+ GitHub stars in under four months.

**What it actually is:** the most architecturally ambitious of the tools analyzed — a full HTTP reverse proxy that sits between a coding agent and the real LLM provider API (OpenAI/Anthropic/Gemini/Vertex/Bedrock/100+ via LiteLLM), compressing message content in-flight, with a reversible cache-and-retrieve system (CCR) so the model can pull back anything it dropped, a cross-agent persistent memory layer, an MCP server, and a from-scratch Rust reimplementation of the hottest compression paths for speed. It is a **direct architectural analogue to DietCode's proxy mode**, at much greater scale and maturity — this is the single most useful competitor to study in depth.

---

## 1. Overall architecture

Not simply "Rust core, Python/TS bindings." More precisely: **a Python-original implementation that is mid-migration to Rust for hot-path compressors**, with three separate Rust build artifacts serving three different roles, plus a TypeScript SDK that is a pure HTTP client with zero compression logic of its own.

### The Cargo workspace (4 members)

- **`crates/headroom-core`** — the real Rust compression engine. Deps: `tiktoken-rs`, HF `tokenizers`, `hf-hub`, `fastembed`/`ort` (ONNX embeddings), `magika` (ONNX content-type classifier), `unidiff`, `rayon`, `blake3`/`sha2`/`md-5`. Modules: `tokenizer/`, `ccr/` (with `backends/{in_memory,sqlite,redis}.rs`), `signals/`, `transforms/` (`smart_crusher/` — 26 files, plus `log_compressor.rs`, `search_compressor.rs`, `diff_compressor.rs`, `content_detector.rs`, `magika_detector.rs`, `tag_protector.rs`, `live_zone.rs`, `recommendations.rs`, `safety.rs`), `relevance/`. Code comments state the explicit goal is **byte-exact parity** with the Python originals (hashes must match Python's `hashlib` output for CCR cache keys) — this is a from-scratch reimplementation engineered for output parity, not a wrapper.
- **`crates/headroom-py`** — thin PyO3 glue (`cdylib`, module `_core`), exposing `SmartCrusher`, `DiffCompressor`, `SearchCompressor`, `LogCompressor`, `TextCrusher`, plus free functions. Each wrapper releases the GIL for compute (`py.detach(|| ...)`) — genuine Rust execution. Confirmed in source: the Python `SmartCrusher` class (`headroom/transforms/smart_crusher.py`) was **retired and now hard-delegates to `headroom._core.SmartCrusher` with no Python fallback**, after byte-equality was verified against 17 recorded fixtures before the Python code was deleted. So for the highest-traffic compressor, Rust genuinely is the engine.
- **`crates/headroom-proxy`** — a **separate**, standalone axum-based reverse-proxy binary, not exposed via PyO3. Per its own header comment: "drops in front of the existing Python proxy... forwards every HTTP/SSE/WebSocket request verbatim to `--upstream`," and independently implements native AWS Bedrock SigV4 signing, native GCP Vertex ADC signing, and a partially-implemented Rust live-zone compression path (`compression/live_zone_anthropic.rs`, 1311 lines; `live_zone_openai.rs`; `live_zone_responses.rs`) plus cache-stabilization logic (tool-def normalization, `cache_control` auto-placement, drift detection, OpenAI `prompt_cache_key` injection).
- **`crates/headroom-parity`** — a Rust-vs-Python **regression harness** (confusingly *not* related to RTK-parity — see §9). Loads JSON fixtures recorded from live Python runs, runs the Rust implementation over the same input, asserts byte-identical output. Wired comparators: `diff_compressor`, `tokenizer`, `smart_crusher`, `content_detector`; three (`ccr`, `log_compressor`, `cache_aligner`) are still `todo!()` stubs. Runs nightly in CI with `continue-on-error: true` — **not a per-PR gate**.

### Build wiring

`pyproject.toml`: `build-backend = "maturin"`, module `headroom._core`, manifest at `crates/headroom-py/Cargo.toml`. One `pip install headroom-ai` builds the Rust extension via maturin→cargo and ships Python source + compiled `.so` in one wheel.

### TypeScript SDK (`sdk/typescript/`, npm `headroom-ai`)

Pure HTTP client. `HeadroomClient` hits `http://localhost:8787` by default, calling `/v1/chat/completions`, `/v1/messages`, `/v1/compress`, health/metrics/retrieve endpoints. Message-format conversion (OpenAI/Anthropic/Vercel-AI/Gemini shapes) happens client-side before POSTing — **zero compression algorithms live in TS**. Explicitly requires a running `headroom proxy` process.

### Deployment surface (5 ways to use it)

1. **Library** — `from headroom import compress`, in-process.
2. **`headroom proxy`** — the primary product: a FastAPI/uvicorn HTTP reverse proxy (`headroom/proxy/server.py`, 5018 lines) where most compression, CCR, memory, and provider routing lives. Optionally fronted by the Rust `headroom-proxy` binary for passthrough + native Bedrock/Vertex signing.
3. **`headroom wrap <agent>`** — launches the Python proxy as a background subprocess, points the target CLI's env vars (`ANTHROPIC_BASE_URL`, etc.) at it, registers MCP tools, execs the wrapped CLI. Directly analogous to `dietcode claude`.
4. **MCP server** (`headroom mcp serve`) — stdio server for subscription-auth agents that can't be proxied.
5. **TypeScript SDK** — HTTP client requiring one of the above already running.

---

## 2. The compression engine

Two separate subsystems, easy to conflate:

### 2.1 `headroom/compression/` — "Universal Compression" (smaller, ~2700 LOC, library-facing)

`detector.py` (ML content-type detection via Magika) → `masks.py` (a structure mask over the content marking what must be preserved) → `handlers/{json_handler.py, code_handler.py}` → compress non-structural spans. `JSONStructureHandler` preserves all keys/brackets/booleans/nulls/high-entropy strings (UUIDs/hashes, entropy threshold 0.85)/short values (<20 chars), compressing only long string values. `CodeStructureHandler` preserves imports/signatures/class defs/type annotations/decorators via tree-sitter AST (8 languages), compressing function bodies and optionally comments. This is the module documented as a standalone library API (`from headroom.compression import compress`).

### 2.2 `headroom/transforms/` — the real hot path used by the proxy (17.9K LOC)

Orchestrated by `TransformPipeline`, whose default order is exactly two stages:

1. **`CacheAligner`** — extracts dynamic content (dates, UUIDs) from the system prompt and moves it to the end, so the stable prefix keeps hitting the provider's prompt cache.
2. **`ContentRouter`** (`content_router.py`, **4758 lines** — the largest single file in the package) — detects content type per message/block and routes to a specific compressor:

| Content type | Strategy | Implementation |
|---|---|---|
| `SOURCE_CODE` | `CODE_AWARE` | tree-sitter AST (`code_compressor.py`, 2293 lines) |
| `JSON_ARRAY` | `SMART_CRUSHER` | statistical, PyO3/Rust-backed |
| `SEARCH_RESULTS` | `SEARCH` | `search_compressor.py` |
| `BUILD_OUTPUT` (compiler/test/lint logs) | `LOG` | `log_compressor.py` |
| `GIT_DIFF` | `DIFF` | `diff_compressor.py` |
| `HTML` | `HTML` | `html_extractor.py` |
| `TABULAR` (CSV/TSV) | `TABULAR` | `tabular_ingest.py` |
| `PLAIN_TEXT` | `TEXT`/`KOMPRESS` | ML token-classifier, opt-in |

**SmartCrusher** — the flagship strategy: analyzes JSON arrays for field type (constant/sequential/unique), does variance/change-point detection (keeps points around statistically significant spikes — e.g. a CPU-usage spike at item 45 of 60), clusters log-like arrays (keeps 1-2 representative items per cluster), does top-N for scored/ranked search results. Schema-preserving: output is always a subset of the original items, never synthetic wrapper text. On a lossy row-drop it appends a CCR sentinel (`{"_ccr_dropped": "<<ccr:HASH N_rows_offloaded>>"}`) to the kept array.

**Kompress** (`kompress_compressor.py`, 1581 lines) — the ML strategy, successor to a retired LLMLingua-2 integration: a fine-tuned **ModernBERT** model (`chopratejas/kompress-v2-base` on HuggingFace, auto-downloaded), run via ONNX Runtime, int8 weight-only quantized (261MB, f1=0.9130) preferred over fp32 (601MB). Per-token keep/drop classification (extractive, LLMLingua-style) — not generative summarization. A regex "must-keep" allowlist always preserves hex addresses, standalone numbers, ALLCAPS identifiers, dotted paths, Unix paths, file extensions, CLI flags, CamelCase identifiers regardless of model score, as a safety rail against the model dropping load-bearing tokens.

**Live-zone-only compression** — the stated design principle (and the subject of an active internal architectural correction, see §13): **Headroom never drops whole messages from conversation history.** Compression only ever touches the newest content blocks (latest user message, latest tool_result); `ContentRouter.apply()` respects a `frozen_message_count` and skips everything before it, specifically to protect the provider's cached prefix. The live implementation layers real nuance on top: an **adaptive compression ratio** scaled by `context_pressure = tokens_before / model_limit`, an **adaptive read-protection window** (detects `cat`/`sed`/`head`-style read commands so an agent never gets lossy output for content it needs byte-exact to edit, gated by `HEADROOM_PROTECT_READS`), and a flag-gated **"net-cost" mutation gate** (`HEADROOM_NET_COST_POLICY`) that allows compressing even frozen/cache-hot messages if the token savings outweigh the cache-bust cost for the suffix that would be invalidated — an explicit economic break-even calculation rather than a hard floor.

**Retired/deprecated**: `ToolCrusher` (naive first-N truncation, disabled by default); `IntelligentContextManager` (score-and-drop message-history summarization) and the `relevance/scoring/rolling_window/progressive_summarizer` machinery are — per the internal self-audit — considered **the wrong architecture** and slated for ~10K LOC of deletion.

### 2.3 `headroom/relevance/` — embeddings-based relevance filtering

`create_scorer(tier="hybrid"|"bm25"|"embedding")`; default `HybridScorer` combines BM25 keyword matching with sentence-transformer embeddings via an adaptive alpha (more BM25 weight for UUID/ID-like queries, more embedding weight for natural language — justified because "BM25 alone gives low scores for single-term matches" and misses semantic matches like "errors"→"failed"). Falls back to BM25-only if `sentence-transformers` isn't installed. Live tension: this subsystem exists and is documented, but is also flagged for retirement per the same self-audit that killed ICM.

---

## 3. CCR — Compress, Cache, Retrieve (the reversibility mechanism)

This is Headroom's most distinctive idea and the one closest to DietCode's own `sd_retrieve` — worth understanding precisely.

1. **Compression**: when SmartCrusher (or `ContentRouter` generally) drops content, it computes a content-addressed hash and stores the *original* payload before compressing.
2. **Store** — `CompressionStore` (`headroom/cache/compression_store.py`): thread-safe, TTL-based (**default 1800s / 30 minutes**, env `HEADROOM_CCR_TTL_SECONDS` — note the project wiki's "5 minute default" is stale relative to the actual source), LRU-capacity-bounded (1000 entries default). Each entry stores hash, original + compressed content, token/item counts, tool name, a tool-signature hash (for TOIN correlation, §8), and retrieval-feedback fields. Pluggable backend (in-memory default; SQLite backend for persistence).
3. **Marker syntax** — two formats coexist: legacy bracket form (`[100 items compressed to 10. Retrieve more: hash=abc123...]`, 24-hex SHA-256 prefix) and SmartCrusher's newer inline form (`<<ccr:HASH>>` or `<<ccr:HASH,KIND,SIZE>>`, 12-24 hex chars).
4. **Tool injection** — when markers are present (or once a session has ever used CCR — see below), the proxy injects a `headroom_retrieve` tool definition (schema: `{hash: string}` only) into the outgoing request, provider-shaped for Anthropic/OpenAI/Google.
   - **Sticky-on invariant**: once a session has used CCR even once, `headroom_retrieve` must be registered on *every* subsequent request in that session — toggling it per-request based on whether *this* turn has fresh markers would flip the `tools[]` array bytes and bust the provider's prompt cache. This was an explicit bug fix (documented in the internal remediation plan).
5. **Retrieval** is hash-only — always returns the full original content; there is no partial/query-based retrieval (a vestigial "search retrievals" field in the feedback model is documented as "legacy, always 0").
6. **Automatic tool-call handling — `CCRResponseHandler`**: the proxy intercepts the model's response, detects `headroom_retrieve` calls, resolves them against the store, constructs a provider-appropriate tool-result message, re-issues the API call with the retrieved content appended, and repeats up to **3 rounds**. **The calling client never sees the intermediate round-trip** — it's fully transparent, proxy-side only. A streaming variant (`StreamingCCRBuffer`) does the same for SSE responses.
   - On a miss (expired/evicted entry), the response includes an actionable recovery message (re-read the file at the given path, re-run the command, with the configured TTL) rather than a bare error.
7. **Context Tracker (proactive expansion)** — `headroom/ccr/context_tracker.py` tracks every compression event across a session and, on a new user query, scores every tracked compressed context by keyword overlap with the sample content + triggering query + tool-name heuristics (with an age discount); above a relevance threshold (0.3 default) it proactively retrieves and expands the content **before the model even asks** — up to 2 proactive expansions per query.
8. **Feedback loop** — tracks per-tool retrieval rate; a high retrieval rate (>50%) signals "compression was too aggressive for this tool" and feeds hints (`max_items`, `skip_compression`, `preserve_fields`, `aggressiveness`) back into SmartCrusher's config.

**Rust CCR store** (`crates/headroom-core/src/ccr/mod.rs`) is a deliberately stripped-down parallel reimplementation — no BM25 search, no retrieval-event feedback, "this crate only needs put/get." Three backends behind a `CcrStore` trait: `InMemoryCcrStore` (sharded DashMap, tests), `SqliteCcrStore` (**production default**, WAL-mode, lazy TTL purge, persists across worker restarts), `RedisCcrStore` (feature-gated, multi-worker). Hash function: **BLAKE3 truncated to 24 hex chars**, explicitly commented as matching the Python regex `[a-f0-9]{24}`.

**Proxy endpoints**: `POST /v1/retrieve` (by hash), `GET /v1/retrieve/{hash}`, `GET /v1/retrieve/stats`, `GET /v1/feedback[/{tool_name}]`. `headroom proxy --no-ccr` disables the whole mechanism.

**MCP vs. proxy-injection are mutually exclusive per request** — "when MCP is configured, tool injection is skipped to avoid duplicates" (see §5).

---

## 4. Proxy mode — the literal reverse proxy

FastAPI + uvicorn (`headroom/proxy/server.py`, 5018 lines; routes in `headroom/providers/proxy_routes.py`). Genuinely general-purpose — it fronts essentially every major provider API shape:

- Anthropic native (`/v1/messages`) and an Azure AI Foundry variant.
- OpenAI chat (`/v1/chat/completions`) and Responses API (`/v1/responses`, plus a WebSocket variant for Codex's streaming Responses API, plus ChatGPT-subscription-auth aliases).
- Native Gemini (`/v1beta/models/{model}:generateContent|streamGenerateContent|countTokens`) and native Vertex AI publisher routes (region-derived upstream resolution), including a hardcoded Anthropic-on-Vertex branch.
- **AWS Bedrock** (`/model/{model_id}/invoke[-with-response-stream]`), registered only when a Bedrock upstream is configured.
- Batch APIs for Anthropic/OpenAI/Gemini.
- Passthrough-with-telemetry for embeddings/moderations/images/audio.
- A catch-all route that auto-selects the upstream provider from request headers (`x-api-key`/`anthropic-version` → Anthropic, `x-goog-api-key` → Gemini, `api-key` → Azure-style) and forwards verbatim.

**For compression-eligible routes**: parse the body into messages → run `TransformPipeline` (§2) on the live zone → inject CCR markers + the `headroom_retrieve` tool (§3) → forward via `httpx` → intercept and resolve any CCR tool calls before the client sees the response. Streaming is handled by a dedicated 1964-line reconstruction path that has to parse and re-emit provider-specific SSE event framing while injecting compressed content mid-stream.

**"Compression as a service"**: `POST /v1/compress` compresses an OpenAI-format messages array with **no LLM call at all** — this is what the TS SDK's `.compress()` method hits, and it's usable standalone by any HTTP client. Response includes `tokens_before/after/saved`, `compression_ratio`, `transforms_applied`, `ccr_hashes`. A `x-headroom-bypass: true` header skips compression and echoes input back, for inline A/B testing.

**`headroom wrap claude` sits on top of the proxy**, not beside it: it launches `python -m headroom.cli proxy --port <port>` as a background subprocess (with a readiness poll — cold-cache ML model preload for Kompress/Magika/tree-sitter can take 20-30s), sets `ANTHROPIC_BASE_URL` to point at it, optionally registers MCP tools and CLI-side hooks, then `exec`s the real agent with unrecognized args passed through. `headroom unwrap` reverses this and is reference-counted (a marker file) so multiple concurrent `wrap` sessions sharing one proxy port don't kill it out from under each other.

**The Rust proxy binary** is meant to sit *in front of* the Python proxy, doing native Bedrock/Vertex signing and (per its config) an eventually-complete live-zone compression path. As of this snapshot it had at least one serious admitted bug: `frozen_message_count: 0` was hardcoded, meaning it ignored customer `cache_control` markers entirely (see §13).

---

## 5. MCP server(s) — two independent servers, easy to conflate

- **`headroom mcp serve`** (`headroom/ccr/mcp_server.py`, 1107 lines, stdio, official `mcp` SDK) — exposes `headroom_compress` (compress arbitrary text on demand, no proxy required), `headroom_retrieve` (checks local store, falls back to the running proxy's HTTP endpoint if reachable), `headroom_stats` (session stats merged across sub-agent processes via a shared, `fcntl`-locked JSONL log), and `headroom_read` (feature-flagged off by default — session-scoped file-read caching: unchanged re-reads return a ~20-token marker instead of the full file). MCP session TTL is 1 hour (vs. the proxy's 30-minute CCR default).
- **A separate memory MCP server** (`headroom/memory/mcp_server.py`, 434 lines) — standalone process, exposes exactly `memory_search`/`memory_save`, and **re-embeds any memory rows lacking a vector embedding on startup** — this is the concrete mechanism that makes memory written via one code path (e.g. the proxy) become searchable via a different agent's MCP call (see §7).
- **`headroom/mcp_registry/`** — not a server, a uniform `MCPRegistrar` per agent's config format (Claude → `~/.claude.json`, prefers the `claude mcp add` CLI; Codex → `~/.codex/config.toml` marker-delimited TOML edits; OpenCode → `~/.config/opencode/opencode.json`). `install_everywhere()` fans registration across every detected agent; a ledger tracks which installs Headroom performed so `unwrap` only removes its own entries. Also auto-installs two third-party MCP servers as companions (Serena for code navigation, a "tokensave" compressor).

---

## 6. Tokenizers and provider routing

`TokenizerRegistry` dispatches per-model via a regex pattern table: `tiktoken` (exact BPE) for `gpt-*`/`o1*`/`o3*`; calibrated char-based estimation (3.5 chars/token) for `claude-*` (Anthropic's tokenizer isn't public); HF `tokenizers` for `llama*`/`qwen*`/`deepseek*`/etc.; the official `mistral-common` SDK for Mistral models; calibrated estimation for Gemini (4.0 chars/token) and Cohere; a specially-calibrated 3.1 chars/token for Moonshot/Kimi models (calibrated against real Fireworks `prompt_tokens` from a SWE-bench run). Unmatched models fall back to generic char-based estimation. The tiktoken encoding is proactively loaded at tokenizer-creation time so a stalled download fails fast into estimation rather than hanging mid-request. `BaseTokenizer.count_messages` handles OpenAI-style per-message overhead accounting plus an extensive set of Strands SDK multi-modal block types, each with its own estimation heuristic (PDF ≈1500 tok/page, video ≈1000 tok/frame). Oversized blobs (>50K chars) are token-counted via even-spread sampling rather than full serialization.

**Provider adapters** are two distinct registries: upstream LLM API wire-format adapters (Anthropic/OpenAI/Google/Cohere/LiteLLM) vs. coding-agent integration adapters (Claude/Codex/Copilot/Aider/Cursor/OpenCode/…, used by `headroom wrap`). `headroom/backends/litellm.py` is the actual multi-provider fan-out ("100+ providers"); a registry entry is only needed for providers requiring custom model-name maps or region handling — everything else works via a generic pass-through config. AWS Bedrock notably has **two independent implementations**: a LiteLLM-mediated Python route (documented as lossy — drops `thinking`/`redacted_thinking`/`document`/`image`/`mcp_tool_use` blocks) and a native Rust SigV4-signed route.

---

## 7. Memory — three distinct mechanisms sharing a name

1. **`HierarchicalMemory`** (`headroom/memory/core.py`, 901 lines) — the genuinely cross-agent, DB-backed system. Hierarchical scope (user/session/agent/turn), temporal supersession, importance-weighted "bubbling," embedding vector. Pluggable backends: SQLite (default), vector index (`sqlite-vec` preferred, else HNSW, or an external plugin), FTS5, embedder (local sentence-transformers/ONNX by default, or OpenAI/Ollama). Cross-agent sharing works via two runtime paths hitting the **same on-disk SQLite file**: the proxy (when run with `--memory`) auto-searches and injects results plus registers `memory_save/search/update/delete/list` tools; the standalone memory MCP server re-indexes on startup for agents not behind the proxy. **Project isolation**: a `BackendRouter` resolves each request to `PROJECT` (default — separate SQLite file per project dir, parsed from a `cwd:` line in the system prompt; fixes a real documented cross-project-bleed bug), `USER`, or `GLOBAL` (legacy, documented as a leak vector). Unresolved-project fallback is fail-closed (skip injection) rather than silently pooling into GLOBAL — tightened after a real incident where a memory from an unrelated session bled into a live thread. Write/read is tool-call-driven, not automatic background extraction, by default. Dedup: cosine-similarity check at save time + background hard-dedupe above 92% similarity. Ranking: `final_score = cosine_score × exp(-age_days / 30)`, deterministic (stable sort) for prompt-cache stability across turns — the module docstring explicitly notes this was added because every competing memory system they surveyed (Letta/Mem0/Cognee/Supermemory) re-ranks beyond cosine, breaking cache stability.
2. **`SharedContext`** (`headroom/shared_context.py`, 219 lines) — in-process-only, never touches disk, a simple TTL cache for multi-agent-*framework* handoffs (CrewAI/LangGraph/OpenAI-Agents-SDK style). Unrelated to the DB memory story despite the name overlap.
3. **File-export writers** (`headroom/memory/writers/`) — export `HierarchicalMemory` entries into agent-native files (`CLAUDE.md`, `AGENTS.md`) with per-agent token budgets, exponential importance decay, `git ls-files`-based staleness detection, and marker-delimited (`<!-- headroom:memory:start/end -->`) idempotent regions.

---

## 8. Prediction / learning — three separate systems, only one currently "acting"

1. **TOIN (Tool Output Intelligence Network)** (`headroom/telemetry/toin.py`, 1605 lines) — pure statistical pattern tracking, **no ML model, no gradient training**. Tracks per-`(auth_mode, model_family, tool_signature_hash)` rolling compression ratio, retrieval rate (the key signal), per-strategy success rates, field-level stats. Privacy-preserving by design (no raw content, hashed tool/field names, no user IDs). **Critically, per its own module docstring, TOIN is now strictly observation-only at request time** — its old request-time recommendation API is retired (emits a `DeprecationWarning`, returns `None` unconditionally) specifically because per-request mutation of compression behavior based on mutable state broke prompt caching and made bugs irreproducible. The actual loop: request-time counters accumulate → an offline `toin_publish` CLI command aggregates (min 50 observations per slice) into a `recommendations.toml` file → the Rust proxy loads it once at startup. **The consumption half isn't wired up yet** — the Rust module's own comment states "the dispatcher does not consume this surface yet," and no call sites exist outside its own tests. So TOIN today records faithfully but doesn't yet act on its own aggregated data.
2. **`headroom/learn/`** — a completely different system: offline mining of past session transcripts, correlating a failure with a later successful recovery, then making an **actual LLM call** (Sonnet/GPT-4o/Gemini Flash, or a local subscription CLI) to synthesize a specific correction written into `CLAUDE.local.md`/`AGENTS.md` via per-agent plugins. Real LLM reasoning at CLI-invocation time — unrelated to compression tuning, a prompt-engineering feedback loop instead.
3. **`headroom/prediction/`** — a 2529-line output-length prediction feature extractor with zero references anywhere else in the repo (including tests/benchmarks) — likely vestigial/aspirational code, distinct from the actually-shipped output-token-reduction feature (`headroom/proxy/output_shaper.py`).

---

## 9. The RTK relationship (important — resolves a naming collision)

`headroom/rtk/` is **not** an internal codename and **not** related to `crates/headroom-parity` (which is Headroom's own Rust-vs-Python regression harness, unrelated despite the shared word "parity"). It is a genuine third-party integration: Headroom **bundles [rtk-ai/rtk](https://github.com/rtk-ai/rtk)** — the exact tool analyzed separately in `competitors/rtk/analysis.md` — as prebuilt binaries fetched from GitHub releases (`RTK_VERSION = "v0.42.4"` pinned), cached at `~/.headroom/bin/rtk`. Headroom's own README states plainly: *"Headroom ships with the excellent RTK binary for shell-output rewriting... their tool is a first-class part of our stack, and Headroom compresses everything downstream of it."* Headroom's own competitor-comparison table lists RTK alongside `lean-ctx`, Compresr, and "OpenAI Compaction" — treated as a peer/partner, not a rival.

**A dated internal architecture decision record** (`docs/rtk-architecture.md`) formally rules that RTK is **wrap-CLI-only, never invoked proxy-side**, for three stated reasons: (1) it would touch the proxy's cache-hot-zone contract for `tool_result` content and reintroduce cache-busting the team specifically spent effort eliminating; (2) it would duplicate the Rust `log_compressor.rs`, which already does output-side compression in the live zone — stated policy is "no silent fallbacks, no parallel impls"; (3) RTK's real value (~50% of its savings, per the doc) comes from rewriting the shell command *before execution*, which a proxy sitting after execution structurally cannot replicate.

**This is directly relevant to DietCode's own architecture decisions**: Headroom — a team that ships both a command-rewrite tool integration *and* an output-compressing proxy — deliberately keeps them at separate layers rather than merging them, and has a written rationale for why. See `competitors/rtk/analysis.md` §8 for the DietCode-specific implication.

---

## 10. Agent integrations (`plugins/`)

Only one plugin (`plugins/headroom-agent-hooks/`) ships through the actual Claude Code marketplace (`.claude-plugin/marketplace.json`); the other four distribute through their own native channels:

- **`headroom-agent-hooks`** (targets Claude Code and GitHub Copilot CLI) — a standard `hooks.json` with `SessionStart` (matcher `"startup|resume"`) and `PreToolUse` (matcher `"Bash|PowerShell"`) both running `headroom init hook ensure` (15s timeout, plain `"type": "command"` shell hooks). This is **not** a compression hook — it's lazy-autostart plumbing that ensures a durable Headroom deployment matching the current profile is already running before the agent needs it.
- **`hermes`** — registers `headroom_retrieve` via Nous Research Hermes's native `register_tool()` API (an HTTP-client plugin POSTing to the proxy).
- **`opencode`** (TypeScript) — an in-process HTTP-transport interceptor routing OpenCode's provider traffic through the proxy, native `headroom_retrieve` registration (Zod-validated), env injection via OpenCode's `shell.env` hook.
- **`openclaw`** (TypeScript, most elaborate) — declares `"kind": "context-engine"`, installs into OpenClaw's `plugins.slots.contextEngine` slot, can rewrite OpenClaw's provider base URLs **in-memory** so traffic transparently routes through the proxy. Requires `--dangerously-force-unsafe-install` because it spawns a subprocess.
- **`headroom-oauth2`** — different category entirely: plugs into *Headroom's own* proxy-side extension point (`headroom.proxy_extension`, see §11), implementing generic OAuth2 client-credentials auth for enterprise gateways (Entra/Okta/Auth0/Keycloak/Cognito) in front of an OpenAI-compatible backend.

None of the non-`headroom-agent-hooks` integrations use Claude-Code-style PreToolUse/PostToolUse hooks — each integrates at its own target platform's native extension point.

---

## 11. Configuration & extensibility

**No project-level config file exists** (no `.headroom.toml`) — configuration is SDK constructor kwargs, CLI flags, or environment variables only. `headroom/config.py` is a pure dataclass surface (`CacheAlignerConfig`, `RelevanceScorerConfig`, `SmartCrusherConfig`, `CCRConfig`, `PrefixFreezeConfig`, top-level `HeadroomConfig`) that reads zero env vars itself — env handling is pushed down into `headroom/proxy/` (18+ files) and `headroom/paths.py`.

**Filesystem contract**: two canonical roots — `HEADROOM_WORKSPACE_DIR` (default `~/.headroom`, all runtime state: savings ledger, telemetry, memory DB, logs, vendored binaries) and `HEADROOM_CONFIG_DIR` (default `~/.headroom/config`). A process-wide "stateless mode" flag forbids all workspace writes, for serverless/read-only deployments.

**Adding a new compression Transform**: implement the `Transform` ABC (`apply(messages, tokenizer, **kwargs) -> TransformResult`, optional `should_apply`). No auto-registry — construct a `TransformPipeline(transforms=[...])` directly.

**Adding a new Provider**: implement the `Provider` ABC (`get_token_counter`, `get_context_limit`, `supports_model`, optional cost/output-buffer overrides).

**The one real plugin/entry-point mechanism**: `headroom/proxy/extensions.py` — third parties declare `[project.entry-points."headroom.proxy_extension"]` in their own package; `install(app, config)` runs at proxy startup. Discovery always runs, but installation is opt-in only (`--proxy-extension <name>` / `HEADROOM_PROXY_EXTENSIONS=name1,name2` / `'*'`), explicitly to avoid silent behavior changes from an unaudited package sharing the environment. The doc comment calls this seam "load-bearing for the Enterprise build" — `headroom-oauth2` is the one shipped example.

---

## 12. Distribution

**PyPI** `headroom-ai`, built via **maturin** (one wheel = Python source + compiled Rust extension). 20+ optional extras (`proxy`, `code`, `ml`, `memory`, `vector`, `relevance`, `image`, `bedrock`, `otel`, `evals`, `[all]`). Requires Python 3.10-3.14.

**Docker**: multi-stage build — builder stage bootstraps a pinned Rust toolchain, `uv pip install ".[proxy,code]"` (transitively invokes maturin→cargo) plus a separate `cargo build --release --bin headroom-proxy`; two runtime variants (slim, and a distroless no-shell variant). `HEALTHCHECK` against `/readyz`. `docker-compose.yml` adds optional `qdrant`/`neo4j` for the memory stack.

**Curl-pipe install scripts** are **Docker-native wrappers, not pip installers** — they pull a `ghcr.io/chopratejas/headroom` image and install a shell wrapper that runs `docker run` for every `headroom` invocation, bind-mounting `~/.headroom`, `~/.claude`, `~/.codex`, `~/.gemini`. This path has a **reduced command surface** (no `headroom wrap copilot`, several `install` flags rejected) — the docs explicitly redirect those cases to the Python-native install.

`headroom/install/` is a separate concern from Docker — the **persistent-deployment manager** (`headroom install apply/status/start/stop/restart/remove`) that patches other agents' configs and manages an OS-level supervisor (systemd/launchd/Windows Task Scheduler) so the proxy survives reboots/logouts.

**Supply chain**: `sbom/` contains real CycloneDX + SPDX SBOMs (prod-only and all-extras variants) plus vuln-scan output, gated by a `deny.toml`.

---

## 13. Notable design decisions, tradeoffs, and admitted weaknesses

The single most valuable thing in this codebase for competitive analysis is an internal, dated, ~13-week self-audit (`REALIGNMENT/`) that is unusually candid about the project's actual state — combined with a candid user-facing limitations doc.

**The core admitted architectural mistake** (`REALIGNMENT/00-overview.md`): *"Headroom is built on the wrong mental model: 'compression means choosing what to drop from conversation history.' The flagship IntelligentContextManager... has been wired into the Rust proxy on `/v1/messages` with `frozen_message_count: 0` hardcoded — so every compression event drops messages from index 0, busting the Anthropic prompt cache for every customer that triggers it."* The corrected model being actively rolled out: "passthrough is sacred; compress only the live zone... the cache hot zone is never touched." ~10K LOC (ICM, scoring, relevance, rolling-window, progressive-summarizer, tool-crusher) is flagged for deletion.

**Other named, open cache-correctness bugs** at time of this snapshot: Python forwarders re-serialize JSON via `httpx ... json=body` with different separators/escaping than the inbound bytes, so outbound bytes are never byte-identical to what the client sent — busts cache for essentially all Python-forwarded traffic; the system prompt is mutated (`.strip()` + memory-context append) at a specific point in `server.py`, busting the cache hot zone on every memory-enabled call; numeric precision is silently lost on a `serde_json::Value` round-trip in the Rust proxy; memory-tool injection toggles the `tools` array and mutates the `anthropic-beta` header mid-session (the CCR sticky-on fix in §3 was one instance of this class of bug being deliberately fixed).

**Bedrock/Vertex support is explicitly self-described as lossy** via the fallback LiteLLM route (drops `thinking`/`redacted_thinking`/`document`/`image`/`mcp_tool_use` blocks, hardcodes `stop_sequence: None`) — a native Rust route exists specifically to fix Bedrock, but the legacy fallback remains in place.

**Security notes surfaced by the audit**: `X-Headroom-*` internal headers found leaking to upstream unstripped in at least one handler (a subscription-revocation fingerprinting risk); the subscription tracker stores a raw OAuth bearer token in process memory; stripping `accept-encoding` can itself reveal the presence of a proxy.

**Candid published limitations** (`wiki/LIMITATIONS.md`): code compression is "gated behind safety protections that prevent it from firing in most real-world scenarios... intentional"; Kompress "adds latency (cost savings only)"; CCR entries silently become genuinely lossy once the 30-minute TTL expires. Published effectiveness table by content type: JSON dict arrays 86-100%, plain text only 43-46%, code effectively passthrough.

**A documented footgun**: `SessionBetaTracker` permanently re-injects any `anthropic-beta` header value ever seen in a session, so a client that stops sending a beta flag still silently gets it re-added — escape hatch is an env var or a full proxy restart.

**Process/culture signal**: `CONTRIBUTING.md` requires a "real behavior proof" on every external PR (exact OS/Python/config/provider tested, repro command, before/after evidence — green CI or mocked tests alone explicitly don't count), a hard 10-open-PRs-per-author cap, and discouragement of refactor-only/test-only PRs unless maintainer-requested — reads as a project that got burned by low-effort/AI-generated PR churn and built explicit guardrails against it.

---

## 14. How this differs from DietCode, and what's worth taking

Headroom is architecturally the closest thing to "what DietCode's proxy mode could become at scale," and its own self-audit is close to a free lessons-learned document for DietCode's roadmap. Concrete points of comparison:

- **DietCode's proxy already embodies Headroom's *corrected* architecture, not its original mistake.** DietCode's README explicitly describes `[ system + tools ] untouched → [ running summary ] → [ last N turns verbatim ]`, i.e. system/tools stay byte-stable and only older-turn content gets folded into a summary — this is exactly the "passthrough is sacred, compress only the live zone, never touch the cache hot zone" principle Headroom spent a ~13-week internal remediation converging toward after shipping the opposite (drop-from-index-0) model first. Worth stating confidently in any positioning material: this is a place DietCode's design is ahead, not behind.
- **CCR vs. `sd_retrieve`** — functionally the same idea (a hash/marker pointing at content the model can pull back on demand), but Headroom's version is considerably more developed: a sticky-on tool-registration invariant to avoid cache-busting, a proactive "context tracker" that expands likely-relevant compressed content *before* the model asks, a feedback loop that adjusts future compression aggressiveness per-tool based on retrieval rate, and a fully transparent multi-round tool-call resolution loop that the calling client never sees. Any of these four refinements would be a natural next increment for DietCode's own retrieval story.
- **Byte-exact re-serialization is a documented, still-open failure mode for Headroom** (JSON round-trip through `httpx` changes separators/escaping) — worth an explicit test in DietCode's own proxy (`src/proxy/transform.ts`, `src/proxy/server.ts`) confirming the untouched `[system + tools]` block really is forwarded byte-identical, not merely semantically-equivalent-after-reserialization, since that's precisely the kind of bug that silently erodes the cache-hit-rate claim DietCode's README leans on.
- **The RTK relationship is a template, not just trivia**: Headroom made a deliberate, written decision to keep a command-rewrite tool (RTK) at the CLI-wrap layer and its own compression strictly at the proxy layer, rather than merging the two, specifically citing cache-hot-zone risk and "no parallel implementations" as reasons. DietCode currently has PostToolUse-level output compression but no PreToolUse command-rewrite layer at all (see `competitors/rtk/analysis.md` §8) — Headroom's decision record is a useful precedent for *how* to reason about adding one (as a separate layer with its own hook, not folded into proxy transform logic) rather than *whether*.
- **Tokenizer-per-model-family dispatch** (tiktoken where exact, calibrated char-ratios per family where not, with real calibration against production `prompt_tokens` for less-common providers like Moonshot/Kimi) is a more rigorous approach than a flat chars/4 estimate (which is what RTK uses, and plausibly closer to what DietCode's own token-savings accounting does today) — worth checking DietCode's `src/stats.ts`/proxy token-counting against this if savings-percentage accuracy across providers ever becomes a claim worth defending precisely.
- **Their memory system's ranking function is a directly citable design constraint worth adopting anywhere DietCode ever ranks or re-orders retrieved content**: `final_score = cosine_score × exp(-age_days/30)` deterministic/stable-sort specifically *because* every other memory system they surveyed re-ranks non-deterministically and busts prompt caching — the same cache-stability logic that motivates DietCode's own "byte-stable summary block between compaction steps" design.
