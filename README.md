# DietCode

Optimize your coding-agent sessions with **DietCode** — automatic context compression, conversation summarization, intent-aware tool routing, and named entity extraction, powered by [Scaledown](https://scaledown.ai).

## What it does

Every time you submit a prompt, the plugin (via hooks in Claude Code and Codex CLI, or via rules guidance in Cursor):

1. **Classifies your intent** and prepends a one-line hint (e.g. `[DietCode intent: file_read (87%)]`) so the agent picks the right tool without guessing
2. **Compresses large contexts** automatically when you paste in a big codebase and ask a retrieval-style question — reducing token usage by 50–70% before the prompt reaches the model
3. **Compresses large tool outputs** (`PostToolUse`) — `ls`, `grep`, `git diff/log/status` are structurally compacted with zero latency, and anything still large is run through Scaledown before it enters context
4. **Tracks token savings** — every compression/summarization is counted, shown live in the Claude Code status line (`↓ 125.4K saved · 747 reqs`)

And — the big one for **real, per-turn token savings** — an optional **proxy mode**:

5. **Progressive compaction via proxy** (`dietcode claude`) — runs Claude Code through a local proxy that rewrites the **outgoing** request on every turn, keeping a running **Scaledown summary** of older turns so the context genuinely *shrinks* instead of growing. This is the only mode that actually reduces tokens (hooks can only *add* context), and it replaces Claude's own lossy auto-compaction. See [Proxy mode](#proxy-mode-real-token-savings).

> **Why not a `PreCompact` hook?** Claude Code's `PreCompact` hook can't replace the compaction summary or remove anything from the window — it can only append (see [anthropics/claude-code#24965](https://github.com/anthropics/claude-code/issues/24965)). Injecting a summary there *costs* tokens rather than saving them, so the real work happens in the proxy, where DietCode controls the request payload.

Compression, summarization, classification, and extraction all happen automatically — driven by DietCode's own hooks and proxy — rather than being left for the agent to decide to call. That keeps their schemas out of every request's tool list and skips the extra tool-call round trip a model-initiated call would cost. The one tool actually exposed to the agent, in **all three clients**, is:

| Tool | What it does |
|---|---|
| `sd_retrieve` | Pull back the original text behind a proxy summary marker (reversibility) |

> **Status line / savings display is Claude Code only.** Cursor and Codex CLI have no status-line API, so token savings still happen there but aren't displayed. This is an npm CLI plugin — there is no VS Code/IDE extension; the "status line" refers to Claude Code's terminal status line.

---

## How it works (30 seconds)

```
your prompt ──▶ [intent classify] ──▶ [needle-in-haystack?] ──▶ compress ──▶ agent
                     │                        │
                 one-line hint          /compress/raw/  (50-70% smaller)
```

- **Intent hints** route the agent to the right tool, cheaply, on every prompt.
- **Auto-compression** only fires on prompts that are both *large* and
  *retrieval-intent*. Conversational prompts and code you're asking it to write
  are left untouched.
- **On-demand tools** give you manual control in any client.

---

## Proxy mode (real token savings)

Hooks can only *add* context to the window — they can never rewrite the
conversation history Claude re-sends every turn. So the only way to genuinely
**reduce** tokens (and to actually replace Claude's compaction) is to sit in the
request path. That's what proxy mode does.

```bash
dietcode claude        # = claude, but routed through DietCode's local proxy
```

This starts a tiny local proxy on `127.0.0.1` (ephemeral port, torn down when
you quit), points Claude Code at it via `ANTHROPIC_BASE_URL`, and launches
`claude` normally. On every request the proxy rewrites the outgoing payload:

```
[ system + tools ]                 ← untouched (keeps Anthropic's prompt cache warm)
[ running Scaledown summary ]      ← stands in for older turns; extended only at compaction steps
[ last N turns verbatim ]          ← the live working set
```

- **Progressive, not per-call.** Most turns make **zero** Scaledown calls — the
  proxy just reuses the cached running summary. Only when (summary + recent turns)
  crosses `SCALEDOWN_PROXY_COMPACT_THRESHOLD` does it make **one** call to fold
  the oldest turns into the summary. Cadence ≈ how often Claude would compact.
- **Replaces native compaction.** Because the forwarded payload stays small, the
  usage Claude Code sees stays low, so its own auto-compaction effectively never
  fires — Scaledown owns compaction instead.
- **Reversible.** Compacted turns are stashed locally; a summary marker tells
  Claude to call `sd_retrieve("<id>")` if it later needs an exact detail.
- **Cache-safe.** The summary block is byte-stable between compaction steps, so
  the cached prefix keeps hitting; it only changes at a compaction step (when
  native compaction would have busted the cache anyway).
- **Fail-open.** Any transform/Scaledown error forwards the original request
  unchanged — the proxy never breaks or drops a request. With no API key it runs
  as a pure passthrough.

> **Claude Code only.** The proxy speaks the Anthropic Messages format. Codex CLI
> and Cursor are unaffected and keep using the hooks/rules described below.

**Make it the default.** `dietcode setup` offers (recommended) to alias `claude` →
`dietcode claude` in your shell config, so you don't have to remember the wrapper.
The alias is shell-only and the wrapper launches the real binary directly, so
there's no recursion; run the unwrapped CLI anytime with `command claude`.

**Knowing whether it's on.** The Claude Code status line tells you live: in a
proxy session it just shows your savings; in a plain `claude` session it appends
`DietCode compaction off` as a reminder. (The agent name stays `DietCode` either
way — it's static config and can't change per session.)

Prefer to manage it yourself? Run the proxy in the foreground and set the env var:

```bash
dietcode proxy --port 8788
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
claude
```

---

## Get started (60 seconds)

> **Supported clients:** Claude Code · Cursor · OpenAI Codex CLI
>
> The MCP tools (`sd_compress`, `sd_summarize`, `sd_classify`, `sd_extract`) work in all three clients. Automatic hooks (`UserPromptSubmit`, `PostToolUse`, `PreCompact`) work in Claude Code and Codex CLI. Cursor has no hook system — use the [Cursor rules](#cursor) to drive proactive tool use instead.

- Node.js 18 or later
- A Scaledown API key, free at [scaledown.ai/dashboard](https://scaledown.ai/dashboard)
- One of: [Claude Code](https://claude.ai/code) · [Cursor](https://cursor.com) · [Codex CLI](https://github.com/openai/codex)

### Claude Code (recommended)

```bash
npm install -g dietcode
dietcode setup
```

The setup wizard will:
1. Open your browser to get an API key
2. Ask you to paste the key (validated against the API before continuing)
3. Save it to your shell config (`~/.zshrc`, `~/.bashrc`, etc.) and to `~/.scaledown/config.json`
4. Register the MCP server with Claude Code (`claude mcp add --scope user`)
5. Write the `UserPromptSubmit`, `PostToolUse`, and `PreCompact` hooks, the **status line**, and the auto-compact threshold to `~/.claude/settings.json`
6. Offer (recommended) to alias `claude` → `dietcode claude` so [proxy mode](#proxy-mode-real-token-savings) is on by default
7. Optionally configure Codex CLI and/or Cursor if you answer **y** when prompted

Restart Claude Code and you're done.

<details>
<summary>Manual setup</summary>

**1. Clone and build**
```bash
git clone https://github.com/scaledown-team/DietCode
cd DietCode
npm install && npm run build
```

**2. Set your API key**
```bash
export SCALEDOWN_API_KEY="your-key-here"   # add to ~/.zshrc or ~/.bashrc to persist
```

**3. Register the MCP server**

Personal use (`~/.claude.json`):
```bash
claude mcp add dietcode --transport stdio \
  -- node /path/to/DietCode/dist/src/index.js
```

Team use (`.mcp.json`, commit this file):
```bash
claude mcp add dietcode --transport stdio --scope project \
  -- npx -y dietcode
```

**4. Add the hook** to `.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "dietcode-hook"
          }
        ]
      }
    ]
  }
}
```
If you cloned instead of installing globally, use the full path:
```json
"command": "node /path/to/DietCode/dist/hooks/user-prompt-submit.js"
```
</details>

### Cursor

```bash
npm install -g dietcode
```

**2. Set your API key**
```bash
export SCALEDOWN_API_KEY="your-key-here"
```

Create `.cursor/mcp.json` (or `~/.cursor/mcp.json` for global use):
```json
{
  "mcpServers": {
    "dietcode": {
      "command": "npx",
      "args": ["-y", "dietcode"],
      "env": {
        "SCALEDOWN_API_KEY": "your-key-here"
      }
    }
  }
}
```
Restart Cursor. The four tools appear in Agent mode.

**4. Restart Cursor.** The four DietCode tools will be available in Agent mode.

**5. (Recommended) Add Cursor rules**

Cursor has no hooks system, but you can give the agent behavioral guidance via `.cursor/rules/`:

```bash
# Global (applies to all projects)
mkdir -p ~/.cursor/rules
cp node_modules/dietcode/cursor-rules/dietcode.mdc ~/.cursor/rules/

# Or project-level
mkdir -p .cursor/rules
cp node_modules/dietcode/cursor-rules/dietcode.mdc .cursor/rules/
```

Or run `dietcode setup` and answer **y** when asked about Cursor — it writes the file for you.

This instructs the agent to call `sd_compress` before large file reads, `sd_summarize` after web fetches, and `sd_classify` at the start of ambiguous tasks.

---

### OpenAI Codex CLI

```bash
npm install -g dietcode
```

**2. Add the MCP server**
```bash
codex mcp add dietcode --env SCALEDOWN_API_KEY=your-key-here -- npx -y dietcode
```
This writes to `~/.codex/config.toml`:
```toml
[mcp_servers.dietcode]
command = "npx"
args = ["-y", "dietcode"]

[mcp_servers.dietcode.env]
SCALEDOWN_API_KEY = "your-key-here"
```

**3. Register automatic hooks**

Codex CLI supports the same hook events as Claude Code. Run the setup wizard and answer **y** when asked about Codex CLI — it appends the following to `~/.codex/config.toml` automatically:

```toml
# DietCode hooks — added by dietcode setup
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node \"/path/to/hooks/user-prompt-submit.js\""
timeout = 30
statusMessage = "DietCode: classifying intent..."

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "node \"/path/to/hooks/post-tool-use.js\""
timeout = 30

[[hooks.PreCompact]]
[[hooks.PreCompact.hooks]]
type = "command"
command = "node \"/path/to/hooks/pre-compact.js\""
timeout = 60
```

> Note: Codex CLI's `PostToolUse` fires only for Bash tool events. File read and MCP tool outputs are not intercepted — those use the on-demand MCP tools instead.

**4. (Optional) Add AGENTS.md**

Copy the provided template to your project root so Codex knows to use DietCode tools proactively:

```bash
cp node_modules/dietcode/agents-md/AGENTS.md ./AGENTS.md
```

---

## Feature comparison

| Feature | Claude Code | Cursor | Codex CLI |
|---|---|---|---|
| `sd_compress` tool | ✅ | ✅ | ✅ |
| `sd_summarize` tool | ✅ | ✅ | ✅ |
| `sd_classify` tool | ✅ | ✅ | ✅ |
| `sd_extract` tool | ✅ | ✅ | ✅ |
| Auto intent hints on every prompt | ✅ hook | ✅ via rules¹ | ✅ hook |
| Auto compression (large prompts) | ✅ hook | ✅ via rules¹ | ✅ hook |
| Auto tool output compression | ✅ hook | ✅ via rules¹ | ✅ hook (Bash only)² |
| Progressive compaction w/ real token savings (Scaledown summarize model) | ✅ proxy⁴ | ❌ | ❌ |
| Token-savings status line | ✅ | ❌³ | ❌³ |
| Context progress bar | ✅ | ❌³ | ❌³ |
| Auto config re-sync on update | ✅ | ✅ | ✅ |

¹ Cursor rules instruct the agent to call DietCode tools proactively — not a true hook, but effective in Agent mode.
² Codex CLI's `PostToolUse` fires only for Bash tool events, not file reads or MCP calls.
³ Cursor and Codex CLI expose no status-line API. Savings still accrue (tracked in `~/.scaledown/stats.json`) but there is no place to display them.
⁴ Proxy mode is opt-in via `dietcode claude` and is Claude Code only (it speaks the Anthropic Messages API). See [Proxy mode](#proxy-mode-real-token-savings).

---

## Usage

**Automatic (Claude Code hook):** nothing to do; the hook fires on every prompt:
```
[DietCode intent: search (82%)]
Find all places where we call the payments API
```

**On-demand tools:** ask the agent directly:
```
Use sd_compress to compress this before searching through it: [paste large codebase]
Use sd_summarize to condense this thread so we can keep working
Use sd_classify to categorize these GitHub issues as bug, feature, or question
Use sd_extract to pull function names, file paths, and error codes from this stack trace
```

---

## Configuration

### Changing your API key

Re-run setup to replace the key automatically:
```bash
dietcode setup
```

Or edit your shell config directly:
```bash
# Open ~/.zshrc (or ~/.bashrc)
# Find and update:
export SCALEDOWN_API_KEY="sk-your-new-key"

# Reload
source ~/.zshrc
```

### Environment variables

Set these environment variables to tune behavior:

| Variable | Default | Description |
|---|---|---|
| `SCALEDOWN_API_KEY` | — | **Required.** Your Scaledown API key |
| `SCALEDOWN_COMPRESS_THRESHOLD` | `10000` | Token estimate above which prompt auto-compression fires |
| `SCALEDOWN_COMPRESS_RATE` | `0.3` | How aggressively to compress (`0.3` = keep ~30% of tokens; `auto` lets the API decide) |
| `SCALEDOWN_NIAH_DISABLE` | `false` | Set to `true` to compress all large prompts, not just retrieval-style ones |
| `SCALEDOWN_POST_TOOL_DISABLE` | `false` | Set to `true` to disable `PostToolUse` tool-output compression |
| `SCALEDOWN_POST_TOOL_THRESHOLD` | `4000` | Token threshold above which tool output is sent to the API (after structural filtering) |
| `SCALEDOWN_COMPACT_THRESHOLD` | `50` | Context-usage % that triggers compaction (also sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) |
| `SCALEDOWN_SHOW_PROGRESS` | `true` | Set to `false` to hide the per-prompt context progress bar |
| `SCALEDOWN_MAX_CONTEXT_TOKENS` | `200000` | Context-window size used for the progress bar / compaction math |
| `SCALEDOWN_PROXY_COMPACT_THRESHOLD` | `50000` | Tokens (summary + recent turns) that trigger a proxy compaction step. Keep below the native auto-compact trigger so the proxy compacts first |
| `SCALEDOWN_PROXY_RECENT_TURNS` | `4` | Number of most-recent turns the proxy keeps verbatim |
| `SCALEDOWN_PROXY_PORT` | `8788` | Port for the foreground `dietcode proxy` (the `dietcode claude` wrapper uses an ephemeral port) |
| `SCALEDOWN_PROXY_UPSTREAM` | `https://api.anthropic.com` | Upstream the proxy forwards to |
| `SCALEDOWN_PROXY_DISABLE` | `false` | Set to `true` to make the proxy a pure passthrough (no compaction) |

```bash
export SCALEDOWN_COMPRESS_THRESHOLD=5000
export SCALEDOWN_COMPRESS_RATE=0.2
```

---

## Updating

```bash
npm update -g dietcode
# or
npm install -g dietcode@latest
```

Your harness config (hooks, status line, Cursor/Codex blocks) is **automatically re-synced on update** for every harness you've already set up — you do not need to re-run setup. This happens two ways:

- A **postinstall** step runs right after `npm install`.
- A **once-a-day self-heal** runs from the Claude Code status line as a safety net (e.g. if `npm install --ignore-scripts` skipped postinstall, or your Node version changed and moved the global install path).

Reconcile only touches harnesses you've already configured — it never adds a harness you didn't opt into, and it preserves your own keys/sections. To force a re-sync immediately:

```bash
dietcode-reconcile
```

> The status line also shows when a new version is available and auto-updates minor versions in the background; major versions print the upgrade command.

---

## Uninstalling

Remove all DietCode integration from every configured harness with one command:

```bash
dietcode uninstall
```

This strips the hooks, status line, and auto-compact env var from `~/.claude/settings.json`, removes the managed block from `~/.codex/config.toml`, deletes `~/.cursor/rules/dietcode.mdc`, removes the `claude` → `dietcode claude` shell alias, and unregisters the MCP server from Claude Code — all while preserving any of your own config in those files.

Then remove the package and (optionally) your data:

```bash
npm uninstall -g dietcode
rm -rf ~/.scaledown          # API key + saved-token stats (optional)
```

Finally, delete the two lines the installer added to your shell config (`~/.zshrc` / `~/.bashrc`):

```bash
export SCALEDOWN_API_KEY="..."
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50
```

**Per-harness manual removal** (if you prefer to do it by hand, or set up MCP manually):

| Harness | What to remove |
|---|---|
| Claude Code | `hooks` (UserPromptSubmit/PostToolUse/PreCompact) + `statusLine` + `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from `~/.claude/settings.json`; `claude mcp remove --scope user dietcode` |
| Cursor | Delete `~/.cursor/rules/dietcode.mdc` (or `.cursor/rules/dietcode.mdc`); remove the `dietcode` entry from `.cursor/mcp.json` |
| Codex CLI | Remove the `# DietCode hooks` block and `[mcp_servers.dietcode]` from `~/.codex/config.toml` |

---

## How compression works

Kode uses a local heuristic to detect "needle-in-a-haystack" queries: prompts
that are both large *and* retrieval-intent (`find`, `search`, `where`,
`what does ... do`, etc.). When detected, the prompt is sent to Scaledown's
`/compress/raw/` endpoint, which rewrites it into a semantically equivalent but
much shorter form before the agent sees it. Long conversational prompts (e.g. code
you're asking it to write from scratch) are left alone.

---

## Development

```bash
git clone https://github.com/scaledown-team/DietCode
cd DietCode
npm install
npm test          # unit tests
npm run build     # compile TypeScript
```

Test the hook:
```bash
echo '{"prompt":"find the function that handles auth"}' \
  | SCALEDOWN_API_KEY=your-key node dist/hooks/user-prompt-submit.js
```

Test the MCP server starts:
```bash
SCALEDOWN_API_KEY=test echo '{}' | node dist/src/index.js
```

---

## License

MIT
