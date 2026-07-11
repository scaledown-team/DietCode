# RTK (Rust Token Killer) — Competitor Analysis

**Repo:** [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk) · **Site:** rtk-ai.app · **License:** Apache 2.0
**Analyzed at:** commit cloned 2026-07-11 (v0.42.4), by cloning the repo locally and reading the full Rust source (`src/`, ~80.7K LOC), `Cargo.toml`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/`.

**One-line pitch (theirs):** "CLI proxy that reduces LLM token consumption by 60-90% on common dev commands. Single Rust binary, zero dependencies."

**What it actually is:** a single, dependency-light Rust binary that (a) installs itself as a `PreToolUse` hook in Claude Code / Cursor / Gemini CLI / Copilot / Factory Droid, (b) intercepts the shell command an agent is about to run, (c) rewrites well-known commands (`git`, `pytest`, `cargo`, `go test`, `eslint`, `ls`, `find`, `grep`, …) to run through `rtk <tool>` instead, and (d) that `rtk <tool>` subcommand re-executes the real tool and **reformats/compresses its stdout** before the agent ever sees it. It does not touch the LLM API traffic at all — it only ever touches shell command execution. This is a fundamentally different point of intervention than DietCode's proxy mode or Headroom's reverse proxy: RTK compresses **at the tool-output source**, before the content ever becomes part of a conversation turn.

---

## 1. Architecture at a glance

Single crate, single binary (`src/main.rs` entry point), no workspace, no async runtime — fully synchronous, targeting <10ms added latency per invocation. Seven top-level modules:

```
src/
  main.rs      — clap Subcommand enum, dispatch, fallback logic (~1500+ lines)
  analytics/   — gain / cc-economics / ccusage reporting
  cmds/        — per-tool output compressors, organized by ecosystem
    git/ rust/ js/ python/ go/ jvm/ php/ ruby/ dotnet/ cloud/ system/
  core/        — config, sqlite tracking, tee (truncation-recovery), truncate caps,
                 guard (never_worse), stream/runner, toml_filter engine, telemetry
  discover/    — rewrite-rule registry (rules.rs), shell lexer, "what am I missing" analytics
  hooks/       — install/verify/permissions/rewrite/integrity for each host agent
  learn/       — learns CLI corrections from Claude Code error history
  parser/      — small shared ParseResult<T> / TokenFormatter trait layer
```

Key deps: `clap` (CLI), `regex` + `lazy_static` (compiled-once rewrite-rule matching), `rusqlite` (bundled SQLite, local usage tracking), `serde`/`toml`, `sha2` (hook integrity + trust hashing), `ureq` (the *only* network call site, telemetry), `ignore`/`walkdir` (gitignore-aware `find`), `automod` (auto-registers `.rs` files as modules). Lint policy denies `unsafe_code` and `warnings` project-wide; the sole exception is one `libc::signal(SIGPIPE, SIG_DFL)` call so `rtk … | head` exits quietly instead of panicking (release profile uses `panic = "abort"`).

### Modes of invocation (all through the one `rtk` binary)

1. **Direct tool wrapper** — `rtk git status`, `rtk cargo test`, `rtk grep …`, `rtk ls`, `rtk find` — ~50 first-class subcommands.
2. **Generic filters** — `rtk err <cmd>` (stderr-only), `rtk test <cmd>`, `rtk summary <cmd>` (heuristic catch-all), `rtk pipe --filter <name>` (stdin mode).
3. **Hook lifecycle** — `rtk init [-g|--agent …]`, `rtk trust`/`untrust`, `rtk verify`, `rtk hook-audit`.
4. **Hook runtime** — `rtk hook claude|cursor|gemini|copilot|droid` (reads the host's PreToolUse JSON off stdin, emits a rewrite/allow/ask/deny decision), `rtk hook check` (dry run).
5. **Rewrite oracle** — `rtk rewrite "<cmd>"` — a stable subprocess API other (non-native/shell-script) hook integrations call to get the same rewrite decision.
6. **Analytics** — `rtk gain`, `rtk cc-economics`, `rtk discover`, `rtk session`, `rtk learn`, `rtk telemetry <sub>`, `rtk config`.
7. **Passthrough** — `rtk run -c "…"` (raw, untracked), `rtk proxy <cmd…>` (raw but tracked).
8. **Fallback** — when clap parsing fails on an unrecognized command, RTK checks the TOML filter registry (see §4) before giving up and passing the command through natively, recording a "parse failure" event either way — this is the mechanism RTK uses to discover its own coverage gaps.

---

## 2. The hook mechanism — how a raw shell command becomes `rtk <tool> …`

This is the most architecturally interesting part of RTK and the piece most worth studying closely, because it is a fully general "intercept + rewrite + gate" pipeline, not just a lookup table.

### 2.1 Tokenize → segment → classify → rewrite

Entry point: `discover::registry::rewrite_command()` (`src/discover/registry.rs:561-596`).

1. Normalizes bash line continuations, bails out entirely (defers to native execution) on heredocs (`<<`) or arithmetic expansion (`$((`) — these constructs are too complex to safely rewrite.
2. Tokenizes the full command line with a hand-rolled, quote/escape-aware shell lexer (`discover/lexer.rs`) that classifies tokens as `Arg` / `Operator` (`&&`, `||`, `;`) / `Pipe` (`|`) / `Redirect` (`>`, `>>`, `2>&1`, …) / `Shellism` (`$()`, backticks, glob, brace-expansion, background `&`).
3. **Compound commands are split at `&&`/`||`/`;`/background-`&` boundaries and each segment is rewritten independently.** For pipes, only the left-hand side of `|` is rewritten — the pipe target (`xargs`, `head`, etc.) is left untouched, and anything already piped from `find`/`fd` is never rewritten at all, because RTK's grouped/summarized output would break whatever is consuming it downstream.
4. Each segment goes through `rewrite_segment_inner()` (`registry.rs:805-973`):
   - Strips an env-var/`sudo` prefix and re-prepends it after rewriting (`RUST_LOG=debug cargo test` → `RUST_LOG=debug rtk cargo test`). A prefix containing `RTK_DISABLED=` short-circuits the whole rewrite (an explicit per-invocation opt-out).
   - Strips "transparent" wrapper prefixes (`noglob`, `command`, `builtin`, `exec`, `nocorrect`, plus user-configured ones like `docker exec mycontainer` or `poetry run` from `config.toml`), recursing up to depth 10, then re-wraps the rewritten command in the same prefix.
   - Strips a trailing `2>&1`-style redirect before matching and re-appends it after.
   - Calls `classify_command()`: normalizes absolute paths to basenames, strips `git -C /path` global flags, normalizes Composer tool paths (`vendor/bin/phpunit` → `phpunit`), then runs a **precompiled `RegexSet`** built once (via `lazy_static!`) from every pattern in the static rule table (`discover/rules.rs`) and takes the last (most specific) match. If nothing in the static table matches, it falls back to the **TOML filter registry** (§4) — this is how tools with no dedicated Rust module (`just`, `jq`, `jj`, …) still get rewritten.
   - Applies the matched rule's `rewrite_prefixes` (longest-first, word-boundary matched) to build the final `rtk <subcommand> …` string. `gh` is special-cased: if the user passed `--json`/`--jq`/`--template`, the rewrite is skipped entirely because those flags mean the caller wants specific structured output RTK's compaction would corrupt.

### 2.2 The rule table (`discover/rules.rs`)

A large static array of entries, each like:

```rust
RtkRule {
    pattern: r"^(?:git|yadm)\s+(?:-[Cc]\s+\S+\s+)*(status|log|diff|show|add|commit|checkout|push|pull|branch|fetch|stash|worktree)",
    rtk_cmd: "rtk git",
    rewrite_prefixes: &["git", "yadm"],
    category: "Git",
    savings_pct: 70.0,
    subcmd_savings: &[("diff", 80.0), ("show", 80.0), ("add", 59.0), ("commit", 59.0)],
    subcmd_status: &[],
},
```

Note `yadm` (a git-compatible dotfile manager) piggybacks on the git pattern for free — the general lesson is that regex-based classification against normalized command text generalizes to command-compatible tools without any extra code. `savings_pct`/`subcmd_savings` feed the `rtk discover` estimator only; they play no role in the actual rewrite decision.

### 2.3 The security gate: unattestable constructs

Before any rewrite can auto-execute, `lexer::contains_unattestable_construct()` scans for command/process substitution (`` `...` ``, `$(...)`, `<(...)`, `>(...)` — quote-aware, so a literal string inside single quotes is fine but the same construct unquoted or in double quotes is flagged) and file-target redirects (fd-dup redirects like `2>&1` and `/dev/null` targets are exempted). **If any such construct is present, RTK refuses to synthesize a rewrite and never returns an `allow` decision** — it defers to the host agent's own native permission handling, because RTK cannot statically prove what the command will actually execute (e.g. `git log --pretty=$(rm -rf /tmp/x)`). This is the single load-bearing security control in the whole system, and it's the direct answer to "how does an auto-rewriting hook avoid becoming an RCE vector."

### 2.4 Permission verdict (`hooks/permissions.rs`)

Before RTK will emit `allow`, it independently re-derives what the *host agent itself* would have decided, by reading and parsing the host's own permission config:
- Claude Code: `.claude/settings.json` + `.claude/settings.local.json` (project and `~/.claude/`, merged), `Bash(...)`-scoped rules only.
- Cursor: `~/.cursor/cli-config.json`, `Shell(...)` rules.
- Gemini: `.gemini/settings.json`'s `tools.allowed`/`confirmationRequired`, gated on `folderTrust`.
- Factory Droid: `.factory/{settings.json,settings.local.json}` — **deny-list only**; Droid's own allow-list is deliberately never consulted, so RTK can never assert `allow` on Droid's behalf even when Droid's own config would have allowed it.

Precedence is `Deny > Ask > Allow > Default(=Ask)`. Compound commands are re-split for this check (newline/`&`/subshell-aware) and **every segment must independently match an allow rule** for the overall verdict to be `Allow` — this closes a real regression (#1213) where one allowed segment could smuggle through an unrelated, unapproved segment in the same chain. Pattern matching supports exact, prefix-with-word-boundary, and glob (`git * main`, `sudo:*`).

`decide_from_verdict()` combines the permission verdict + the unattestable-construct gate + the registry rewrite into one of four decisions: `AllowRewrite`, `AskRewrite`, `Defer`, `Deny`. Critically, `PermissionVerdict::Default` (no matching rule at all) maps to `Ask`, **never** `Allow` — explicitly regression-tested, because mapping `Default` to `Allow` would silently auto-approve any command the user hadn't explicitly configured a rule for, defeating the host agent's own least-privilege default.

### 2.5 Per-agent JSON protocols (`hooks/hook_cmd.rs`)

`rtk hook claude` reads Claude Code's PreToolUse JSON (`{"tool_name":"Bash","tool_input":{"command":"..."}}`) and on `AllowRewrite` emits:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecisionReason":"RTK auto-rewrite","updatedInput":{"command":"rtk git status"},"permissionDecision":"allow"}}
```

On `AskRewrite`, the same JSON shape is emitted but **`permissionDecision` is omitted** — this is the exact mechanism that turns "no rule matched" into "Claude Code's own confirmation prompt fires, but on the *rewritten* command." On `Deny`/`Defer`, RTK emits **nothing at all**, so Claude Code evaluates the original unmodified command through its own native path. Every hook handler is required to return `Ok(())` on literally every path (including malformed JSON input) — an `Err` propagating out of `main()` would exit non-zero and block the agent's tool call outright, which is treated as a severity-1 bug class in the codebase.

Per-host variants each match that host's native hook contract: Cursor (`{"permission":"allow"|"ask", "updated_input":{...}}`, strips UTF-8 BOMs Cursor-on-Windows prepends), Gemini (`{"decision":"allow"|"ask_user"|"deny"}` — no native "ask" concept exists so both `Ask` and `Default` map to `ask_user`), Copilot (auto-detects VS Code vs. CLI JSON shape), Droid (never emits `permissionDecision` at all, by design — see §2.4).

### 2.6 Installation (`hooks/init.rs`)

`rtk init` supports 9 agent targets. For Claude Code's default global install it: migrates any legacy shell-script hook, writes a slim `~/.claude/RTK.md`, patches `~/.claude/CLAUDE.md` to `@import` it, and **patches `~/.claude/settings.json`** by deep-merging a `PreToolUse` hook entry (`{"matcher": "Bash", "hooks": [{"type": "command", "command": "rtk hook claude"}]}`) — with an interactive/auto/skip patch-mode, a `.bak` backup before writing, and an atomic write (temp file + rename). It also stores a SHA-256 integrity baseline of the installed hook (`hooks/integrity.rs`) — meaningful mainly for the legacy shell-script install path, since a native binary command has "nothing to tamper with" in the same way a script does; `runtime_check()` hard-exits if the hash doesn't match.

### 2.7 Trust model for project-local filters (`hooks/trust.rs`)

`.rtk/filters.toml` (project-local, i.e. committed to a repo you might `git clone` from someone else) and `~/.config/rtk/filters.toml` (global) are **untrusted by default and not loaded until a human reviews them** via `rtk trust`. This closes a real supply-chain vector: a malicious `.rtk/filters.toml` in a public repo could use the TOML filter engine's `replace`/`match_output` primitives to hide a security scanner's findings or a malicious diff from the agent's view. Trust is recorded as a SHA-256 of the file content; any content change invalidates it. A CI-only override (`RTK_TRUST_PROJECT_FILTERS=1`) exists but is explicitly ignored outside a detected CI environment, to prevent local `.envrc`-style injection from silently trusting a malicious filter file.

---

## 3. The compressors — what actually happens to command output

There is **no single uniform pipeline**. `src/parser/` provides a small shared layer (a `ParseResult<T> = Full(T) | Degraded(T, Vec<String>) | Passthrough(String)` three-tier degradation contract, plus a `TokenFormatter` trait for a couple of canonical types used by JS test runners), but most of the ~50 compressors are bespoke `&str -> String` transforms. The documented taxonomy (`docs/contributing/ARCHITECTURE.md`) groups them into 12 strategies: stats extraction, error-only filtering, grouping-by-pattern, deduplication, structure-only (JSON keys+types), code filtering (strip comments/bodies), failure-focus (hide passing tests), tree compression (`ls`), progress-bar filtering, JSON/text dual-mode, state-machine parsing, and NDJSON streaming (`go test`).

Representative, verified examples:

- **`git diff`/`git show`** (`cmds/git/git.rs`): runs `--stat` first as a verbatim header, then compacts the full diff — keeps `@@` hunk headers with function context, shows up to 100 `+`/`-` lines per hunk verbatim (unmodified — never rewritten or summarized, only truncated with a `... (N lines truncated)` marker), hard-caps total output at 500 lines with a `[full diff: rtk git diff --no-compact]` escape hatch. `--stat`/`--numstat`/`--no-compact` bypass compaction entirely.
- **`git log`**: injects a custom `--pretty=format:` and a default commit-count limit *only if the user didn't already specify one*, splits commits on a sentinel, truncates headers, keeps up to 3 body lines per commit (dropping `Signed-off-by:`/`Co-authored-by:` trailers).
- **`git status`**: uses `--porcelain -b` for compact rendering, but runs a **second** plain `git status` call specifically to detect rebase/merge/cherry-pick/bisect-in-progress state, because porcelain mode drops that prose entirely — explicitly flagged in a code comment as "a correctness bug" that had to be fixed, i.e. compression must never hide operationally-critical state.
- **`pytest`**: injects `--tb=short -q -rxX` if unset, runs output through a 4-state machine (`Header → TestProgress → Failures → Summary`) that drops per-test progress dots, keeps ≤3 relevant lines per failure, and reconstructs `"Pytest: N passed, M failed, K skipped, J xfailed"` + up to 10 numbered failures, with `xfail`/`xpass` deliberately surfaced (not folded into pass/fail) since an unexpected pass is itself a signal worth keeping.
- **`cargo test`**: implemented against a shared streaming `BlockHandler` trait (not a post-hoc string filter) — drops `Compiling`/`Downloading` banner noise and per-test `ok` lines *as they stream*, captures `---- test_name ----` failure blocks verbatim and unabridged, and swallows cargo's redundant double-listing of failure names.
- **`ls`**: always runs native `ls -la` under `LC_ALL=C` internally (locale-stable date format used purely as a parsing anchor), locates the fixed date field by regex rather than fixed column offsets (robust against owner/group names containing spaces — a real regression, #948), drops permission/owner/group columns by default, filters noise dirs (`.git`, `node_modules`, `target`) unless `-a` is passed, appends a one-line extension-count summary only when stdout is a TTY (never for piped/agent consumption).
- **`find`**: uses the `ignore` crate's `WalkBuilder` (the same gitignore-aware walker ripgrep uses) rather than shelling to native `find`; explicitly rejects flags it can't faithfully reproduce (`-exec`, `-delete`, `-size`) rather than silently misbehaving; groups results by parent directory, caps total at 50 (budget-allocated across directories), appends an extension-count tail.
- **`grep`/`rg`**: forces NUL-separated output internally for unambiguous parsing, groups matches by file, caps per-file and overall, truncates long lines — and computes **two full renderings** (a capped/grouped one and a faithful passthrough baseline) and only uses the capped one if capping actually shrank the output; otherwise it emits the faithful baseline unchanged.
- **`rtk summary <cmd>`**: the lowest-fidelity, generic catch-all — sniffs an output "type" from keyword substrings and dispatches to one of 6 heuristic summarizers that count occurrences of words like "passed"/"failed"/"error"/"warning." No structural parsing, no LLM call — regex/substring heuristics only, used solely when nothing more specific applies.

**There is no LLM-based or embeddings-based summarization anywhere in RTK.** The `rtk smart` command's "2-line technical summary" is explicitly `model: heuristic` in its own CLI help text — a stub for a possible future local model, with no inference dependency present in `Cargo.toml`.

---

## 4. Two universal, tool-agnostic primitives (the reusable ideas here)

Every compressor, regardless of which tool it wraps, is expected to compose with these two mechanisms — they're the closest thing RTK has to a "core engine," and they're the most portable ideas for another project to borrow.

### 4.1 `never_worse` — a hard invariant, not a best-effort heuristic

```rust
pub fn never_worse<'a>(raw: &'a str, filtered: &'a str) -> &'a str {
    if estimate_tokens(filtered) > estimate_tokens(raw) { raw } else { filtered }
}
```

Called at the end of nearly every filter. Token estimation itself is deliberately crude — `text.len() / 4.0` rounded up, not a real tokenizer — but that's fine because it only needs to be *directionally correct* for a size comparison, not exact for billing. The result: RTK's compression **structurally cannot** make output larger than the tool's raw output; worst case it degrades to raw passthrough. This is the single most reusable design idea in the codebase — turning "our compression might occasionally backfire" into "cannot backfire by construction," at the cost of sometimes running the underlying command's own summary flag (`--stat`) as an extra subprocess call purely for comparison.

### 4.2 Tee-based truncation recovery

Whenever a filter caps a list (`CAP_ERRORS=20`, `CAP_WARNINGS=10`, `CAP_LIST=20`, `CAP_INVENTORY=50` — four named constants shared project-wide, with a convention that no cap literal appears bare anywhere in the codebase), the *full* raw content is optionally written to `~/.local/share/rtk/tee/<epoch>_<slug>.log` and the truncated output carries a pointer like `+42 more in src/foo.rs (rtk tee grep_skipped)`. This is what makes RTK's caps genuinely "lossy-with-a-recovery-path" instead of silently lossy — documented as a hard contract ("never show `… +N more` without a recovery path"). Governed by min-size gating (skip teeing under 500 bytes), a 1MB per-file cap, and rotation (keep last 20 tee files).

---

## 5. Extensibility model

Two declarative/imperative paths, by design:

1. **TOML filter** (`src/filters/*.toml`, ~60 shipped) — for plain-text, regex-tractable output with no need for flag injection or cross-command routing. An 8-stage fixed pipeline: `strip_ansi → replace (chainable regex substitution) → match_output (short-circuit canned message on a full-blob pattern, with an `unless` guard) → strip/keep_lines_matching → truncate_lines_at → head/tail_lines → max_lines → on_empty`. Filters can embed inline test cases (`[[tests.<name>]]`) that `rtk verify` checks; CI can require every filter have tests. Built-ins are concatenated at compile time by `build.rs` and embedded via `include_str!`. Lookup order: project `.rtk/filters.toml` (trust-gated) → global (trust-gated) → compiled-in built-ins → passthrough.
2. **Rust module** (`src/cmds/<ecosystem>/<tool>_cmd.rs`) — for structured (JSON/NDJSON) output, stateful multi-phase parsing, or output that requires injecting CLI flags. The ecosystem `mod.rs` auto-registers new files via `automod::dir!()`; a developer still has to add a `Commands::` variant + match arm in `main.rs` and a rewrite pattern in `discover/rules.rs`.

Decision rule stated in `CONTRIBUTING.md`: TOML for `brew`/`df`/`shellcheck`/`rsync`/`ping`; Rust for `vitest`/`pytest`/`golangci-lint`/`gh`.

---

## 6. Configuration, distribution, network behavior

- **Config**: `~/.config/rtk/config.toml` — `[tracking]`, `[display]`, `[filters]` (ignore dirs), `[tee]`, `[telemetry]` (opt-in), `[hooks]` (`exclude_commands`, `transparent_prefixes`), `[limits]` (per-feature caps like `grep_max_results=200`).
- **Env vars**: `RTK_DISABLED=1` (single-invocation opt-out), `RTK_NO_TOML=1`, `RTK_TOML_DEBUG=1`, `RTK_HOOK_AUDIT=1`, `RTK_TELEMETRY_DISABLED=1`, `RTK_TEE_DIR`, `RTK_TRUST_PROJECT_FILTERS=1` (CI-only), `RTK_INSTALL_DIR`.
- **Install**: prebuilt binary via `install.sh` (GitHub Releases), Homebrew tap, or `cargo install`. Single ~4.1MB stripped binary (`opt-level=3, lto=true, codegen-units=1, panic="abort"`).
- **Network**: exactly one call site in the whole binary — an opt-in telemetry ping, gated by four independent conditions (compiled-in telemetry URL, not disabled via env, explicit GDPR opt-in stored in config, a 23-hour cooldown), fired fire-and-forget from a detached thread, payload documented field-by-field (anonymous salted device hash, aggregate counts, tool names only — never command lines, file paths, or code). Local usage tracking (SQLite, always on unless disabled) is a fully separate, server-less concern that powers `rtk gain`/`rtk cc-economics`.

---

## 7. Design philosophy (stated and observed)

From `CONTRIBUTING.md`'s four stated principles, each independently verified in code:

1. **Correctness over token savings, and flag-aware.** Default invocations compress aggressively; explicit verbose flags get full detail back, "because the LLM asked for it and needs it."
2. **Transparency.** Output must look like a shorter version of the *real* tool's output, never an RTK-invented format — enforced mechanically by `never_worse`.
3. **Never block.** Every failure path (filter error, malformed hook JSON) falls back to raw passthrough / a silent `Ok(())` rather than erroring the agent's tool call.
4. **Zero overhead.** Fully synchronous, no async runtime, all regexes compiled once via `lazy_static!`, target <10ms/invocation (self-measured: +8ms `git status`, +12ms `grep`, +20ms `go test`).

A fifth, unstated-but-obvious principle from the code itself: **security review as an ongoing practice, not an afterthought.** The unattestable-construct gate, the all-segments-must-independently-match-allow rule for compound commands (regression-tested against a specific past bug), the Droid "never assert `allow` even when Droid's own config would have allowed it" stance, and the trust-before-load model for project-local filters all read as direct responses to an internal security review (referenced in code as `SA-2025-RTK-001`) — this is a hook-based auto-rewriter that has clearly been red-teamed for "how would a malicious repo or a confused LLM abuse an auto-approving hook."

---

## 8. How this differs from DietCode, and what's worth taking

DietCode today (`src/proxy/`, `src/tools/`, hooks in `hooks/`) intervenes at two points: (a) `PostToolUse`/`UserPromptSubmit` hooks that can only *add* a hint or trigger a compression call on large pasted context, and (b) proxy mode, which rewrites the outgoing LLM API payload (system+tools untouched, running summary + last N turns). **RTK never touches LLM API traffic at all** — it intervenes one layer earlier, at the point where a shell command is *about to run*, and shrinks the tool-output before it ever becomes part of a conversation turn. These are complementary, not competing, layers: even a perfect proxy-mode summarizer still has to summarize whatever a raw `git diff` or `pytest` run dumped into context in the first place; RTK's bet is that shrinking that dump at the source is cheaper and more precise than summarizing it after the fact.

Concrete ideas worth evaluating for DietCode:

- **`never_worse` as a hard invariant.** DietCode's Scaledown-call-based compression (`sd_compress`, proxy summarization) has no equivalent "structurally cannot make it worse" guarantee today — it's presumably rare that compression backfires, but RTK's pattern (compute both, keep the smaller by a cheap token estimate) is a nearly-free safety net worth considering for `src/proxy/transform.ts` and the `sd_compress` tool path.
- **Tee-based recovery for truncated output**, applicable anywhere DietCode caps or truncates a `PostToolUse` output before compressing it — currently DietCode's reversibility story (`sd_retrieve`) is proxy-summary-level; a source-level recovery pointer for raw tool output would be a finer-grained complement.
- **A PreToolUse command-rewrite layer is a real, currently-unaddressed gap for DietCode.** DietCode's `PostToolUse` hook can compress `ls`/`grep`/`git diff/log/status` output *after* the fact, but doesn't rewrite the command itself the way RTK does (e.g. auto-adding `-n 50` to `git log`, or `--tb=short -q` to `pytest`) — command-level rewriting captures savings a post-hoc output filter cannot, because the expensive/verbose output is never generated in the first place.
- **The permission-verdict re-derivation pattern** (re-parsing the host agent's own settings.json before ever asserting `allow`) is a rigorous template for any future DietCode feature that wants to auto-approve or auto-modify a tool call, rather than merely observe it.
- **Interestingly, Headroom (the other analyzed competitor) already bundles RTK itself** as a first-class part of its stack (see `competitors/headrom/analysis.md` §9) rather than building a competing command-rewrite layer, and has a written architectural decision to keep RTK strictly at the CLI-wrap layer, never proxy-side, specifically to avoid re-touching the prompt-cache-hot zone. That's a strong signal that "rewrite the command" and "compress the traffic" are considered genuinely separate layers by a team that ships both — worth deciding deliberately for DietCode rather than by default.
