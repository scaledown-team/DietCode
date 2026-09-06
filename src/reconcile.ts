// Keeps each harness's on-disk config in sync with the installed package.
//
// The problem this solves: `npm install -g dietcode@latest`
// only replaces files under dist/. It never touches the user's harness configs
// (~/.claude/settings.json, ~/.codex/config.toml, ~/.cursor/rules/dietcode.mdc),
// which were written once by `dietcode setup`. So new managed keys
// (e.g. statusLine) never reach existing users, and absolute hook paths baked in
// at setup time break when the Node version (and thus the global install path)
// changes.
//
// reconcileAll() re-writes only the *managed* portions of configs for harnesses
// the user has ALREADY set up. It never adds a harness the user didn't opt into,
// resolves hook paths at runtime (fixing path drift), and is idempotent.

import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// From dist/src/reconcile.js, the package root (DIST_ROOT) is ../..
const DIST_ROOT = resolve(__dirname, "..", "..");

let PKG_VERSION = "0.0.0";
try {
  PKG_VERSION = JSON.parse(
    readFileSync(resolve(DIST_ROOT, "package.json"), "utf8")
  ).version ?? "0.0.0";
} catch {
  // non-fatal
}

const HOOK = (name: string) =>
  `node "${resolve(DIST_ROOT, "dist", "hooks", name)}"`;

export interface ReconcileResult {
  claude: boolean;
  codex: boolean;
  cursor: boolean;
}

// ---------------------------------------------------------------------------
// Claude Code — ~/.claude/settings.json
// ---------------------------------------------------------------------------

// Resolved lazily (not at module load) so the path reflects $HOME at call time —
// important for tests that sandbox HOME, and harmless in production.
const claudeSettingsPath = () => resolve(homedir(), ".claude", "settings.json");

// A user is "configured for Claude Code" if settings.json already contains our
// hooks (i.e. they ran setup at some point). Matches both DietCode installs and
// pre-rename Scaledown installs so existing users get migrated on update.
function claudeIsConfigured(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks) return false;
  const json = JSON.stringify(hooks);
  return (
    json.includes("user-prompt-submit.js") ||
    json.includes("dietcode") ||
    json.includes("scaledown")
  );
}

function reconcileClaude(): boolean {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return false;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false; // malformed — don't clobber a file we can't parse
  }

  if (!claudeIsConfigured(settings)) return false;

  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};
  hooks.UserPromptSubmit = [
    { matcher: "", hooks: [{ type: "command", command: HOOK("user-prompt-submit.js") }] },
  ];
  hooks.PostToolUse = [
    { matcher: "", hooks: [{ type: "command", command: HOOK("post-tool-use.js") }] },
  ];
  hooks.PreCompact = [
    { matcher: "", hooks: [{ type: "command", command: HOOK("pre-compact.js") }] },
  ];
  settings.hooks = hooks;

  settings.statusLine = {
    type: "command",
    command: HOOK("status.js"),
    refreshInterval: 5000,
  };

  // Active agent name shown by Claude Code. Migrate the pre-rename value.
  if (settings.agent === "scaledown" || settings.agent === "dietcode" || !settings.agent) {
    settings.agent = "DietCode";
  }

  const env = (settings.env as Record<string, string>) ?? {};
  if (!env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) {
    env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE =
      process.env.SCALEDOWN_COMPACT_THRESHOLD ?? "50";
  }
  settings.env = env;

  delete settings._scaledownVersion; // migrate pre-rename stamp
  settings._dietcodeVersion = PKG_VERSION;

  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Codex CLI — ~/.codex/config.toml
// ---------------------------------------------------------------------------

const codexConfigPath = () => resolve(homedir(), ".codex", "config.toml");

function tomlStringValue(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Matches both the new DietCode marker and the pre-rename Scaledown marker so
// existing Codex users are migrated on update rather than gaining a second block.
const CODEX_MARKER_RE = /# (?:DietCode|Scaledown) hooks/;
const CODEX_BLOCK_RE =
  /# (?:DietCode|Scaledown) hooks[\s\S]*?(?=\n\[(?!\[|hooks\b)|$)/;

function buildCodexHooksToml(): string {
  return [
    `# DietCode hooks — managed by dietcode (v${PKG_VERSION})`,
    `[[hooks.UserPromptSubmit]]`,
    `[[hooks.UserPromptSubmit.hooks]]`,
    `type = "command"`,
    `command = ${tomlStringValue(HOOK("user-prompt-submit.js"))}`,
    `timeout = 30`,
    `statusMessage = "DietCode: classifying intent..."`,
    ``,
    `[[hooks.PostToolUse]]`,
    `[[hooks.PostToolUse.hooks]]`,
    `type = "command"`,
    `command = ${tomlStringValue(HOOK("post-tool-use.js"))}`,
    `timeout = 30`,
    ``,
    `[[hooks.PreCompact]]`,
    `[[hooks.PreCompact.hooks]]`,
    `type = "command"`,
    `command = ${tomlStringValue(HOOK("pre-compact.js"))}`,
    `timeout = 60`,
    ``,
  ].join("\n");
}

function reconcileCodex(): boolean {
  const path = codexConfigPath();
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, "utf8");
  if (!CODEX_MARKER_RE.test(existing)) return false; // not set up

  // Replace the whole managed block: from the marker up to the next top-level
  // section that is NOT one of our hook tables ([hooks…] / [[hooks…]]), or EOF.
  // The negative lookahead must permit a second `[` so `[[hooks.X]]` sub-tables
  // stay inside the match instead of prematurely ending it.
  const updated = existing.replace(CODEX_BLOCK_RE, buildCodexHooksToml());
  writeFileSync(path, updated, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Cursor — ~/.cursor/rules/dietcode.mdc
// ---------------------------------------------------------------------------

export const CURSOR_RULES_CONTENT = `---
description: DietCode context optimization — currently unavailable in Cursor
globs:
alwaysApply: true
---

# DietCode Context Optimization

DietCode's compression, summarization, classification, and extraction run automatically via hooks in Claude Code and Codex CLI. Cursor has no hook system, and the MCP tools (\`sd_compress\`, \`sd_summarize\`, \`sd_classify\`, \`sd_extract\`) that used to let this rule drive the same behavior in Agent mode are no longer exposed — do not attempt to call them, they don't exist.

The only DietCode tool available here is \`sd_retrieve\`, which pulls back an original behind a Claude Code proxy summary marker. It has nothing to retrieve outside that context, so there's no proactive use for it in Cursor today.
`;

const cursorRulesDir = () => resolve(homedir(), ".cursor", "rules");
const cursorRulesGlobalPath = () => resolve(cursorRulesDir(), "dietcode.mdc");
const cursorRulesLegacyPath = () => resolve(cursorRulesDir(), "scaledown.mdc");

function reconcileCursor(): boolean {
  // Only refresh the global rules file if it already exists. Project-scoped
  // rules live in arbitrary repos we can't enumerate, so we leave those alone.
  const path = cursorRulesGlobalPath();
  const legacy = cursorRulesLegacyPath();
  if (!existsSync(path) && !existsSync(legacy)) return false;
  if (existsSync(legacy)) rmSync(legacy, { force: true }); // migrate filename
  writeFileSync(path, CURSOR_RULES_CONTENT, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Re-writes managed config for every harness the user has already set up.
// Each step is independently guarded and fail-soft: one harness erroring never
// blocks the others (or the npm install that triggered us).
export function reconcileAll(): ReconcileResult {
  return {
    claude: safe(reconcileClaude),
    codex: safe(reconcileCodex),
    cursor: safe(reconcileCursor),
  };
}

function safe(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Uninstall — strips all DietCode-managed config from each harness, leaving
// user content intact. Counterpart to reconcileAll(). Does NOT remove the npm
// package itself or the ~/.scaledown data dir (API key, stats).
// ---------------------------------------------------------------------------

// Identifies a hook entry we own — matches DietCode and pre-rename Scaledown
// installs by package name or by our hook filenames.
function isOurHookEntry(entry: unknown): boolean {
  const json = JSON.stringify(entry);
  return (
    json.includes("dietcode") ||
    json.includes("scaledown") ||
    /user-prompt-submit\.js|post-tool-use\.js|pre-compact\.js|status\.js/.test(json)
  );
}

function uninstallClaude(): boolean {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return false;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  let changed = false;

  if (hooks) {
    for (const event of ["UserPromptSubmit", "PostToolUse", "PreCompact"]) {
      const arr = hooks[event];
      if (!Array.isArray(arr)) continue;
      const kept = arr.filter((entry) => !isOurHookEntry(entry));
      if (kept.length !== arr.length) changed = true;
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  const statusLine = settings.statusLine as { command?: string } | undefined;
  if (statusLine && typeof statusLine.command === "string" && isOurHookEntry(statusLine)) {
    delete settings.statusLine;
    changed = true;
  }

  if (settings.agent === "DietCode" || settings.agent === "dietcode" || settings.agent === "scaledown") {
    delete settings.agent;
    changed = true;
  }

  const env = settings.env as Record<string, string> | undefined;
  if (env && "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" in env) {
    delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
    if (Object.keys(env).length === 0) delete settings.env;
    changed = true;
  }

  for (const stamp of ["_scaledownVersion", "_dietcodeVersion"]) {
    if (stamp in settings) {
      delete settings[stamp];
      changed = true;
    }
  }

  if (!changed) return false;
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}

function uninstallCodex(): boolean {
  const path = codexConfigPath();
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, "utf8");
  if (!CODEX_MARKER_RE.test(existing)) return false;
  // Remove the whole managed block (and collapse leftover blank lines).
  const updated = existing
    .replace(/\n*# (?:DietCode|Scaledown) hooks[\s\S]*?(?=\n\[(?!\[|hooks\b)|$)/, "")
    .replace(/\n{3,}/g, "\n\n");
  writeFileSync(path, updated, "utf8");
  return true;
}

function uninstallCursor(): boolean {
  let removed = false;
  for (const p of [cursorRulesGlobalPath(), cursorRulesLegacyPath()]) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed = true;
    }
  }
  return removed;
}

export function uninstallAll(): ReconcileResult {
  return {
    claude: safe(uninstallClaude),
    codex: safe(uninstallCodex),
    cursor: safe(uninstallCursor),
  };
}

export { PKG_VERSION };
