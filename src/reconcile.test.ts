/**
 * reconcileAll()/uninstallAll() against a sandboxed $HOME: DietCode must only
 * add or refresh its own hooks, never drop user hooks or a user statusLine,
 * and never (re)write CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (issue #29).
 */

import { jest } from "@jest/globals";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import * as os from "os";
import { resolve } from "path";

// Jest's module sandbox doesn't propagate process.env.HOME to os.homedir(), so
// mock it outright — otherwise these tests would rewrite the real ~/.claude.
let home = "";
jest.unstable_mockModule("os", () => ({ ...os, homedir: () => home }));
const { applyClaudeHooks, isOurHookCommand, reconcileAll, uninstallAll } = await import("./reconcile.js");

type Group = { matcher: string; hooks: Array<{ type: string; command: string }> };
type Settings = {
  hooks?: Record<string, Group[]>;
  statusLine?: { command: string };
  env?: Record<string, string>;
};

const OLD_DIETCODE = "/usr/local/lib/node_modules/dietcode/dist/hooks";
const USER_PROMPT_HOOK = { type: "command", command: "node ~/my-rules/inject.js" };
const USER_STATUS = { type: "command", command: "~/bin/my-status.sh" };

function settingsPath(): string {
  return resolve(home, ".claude", "settings.json");
}

function writeSettings(settings: unknown): void {
  mkdirSync(resolve(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath(), "utf8"));
}

function commands(settings: Settings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

beforeEach(() => {
  home = mkdtempSync(resolve(os.tmpdir(), "dietcode-reconcile-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("isOurHookCommand", () => {
  it("matches DietCode and pre-rename Scaledown hook scripts", () => {
    expect(isOurHookCommand(`node "${OLD_DIETCODE}/post-tool-use.js"`)).toBe(true);
    expect(isOurHookCommand('node "/opt/node_modules/scaledown/dist/hooks/status.js"')).toBe(true);
  });

  it("does not match user hooks", () => {
    expect(isOurHookCommand("node ~/my-rules/inject.js")).toBe(false);
    expect(isOurHookCommand("node ~/scripts/status.js")).toBe(false);
    expect(isOurHookCommand(undefined)).toBe(false);
  });
});

describe("applyClaudeHooks", () => {
  const ours = {
    UserPromptSubmit: 'node "/checkout/dist/hooks/user-prompt-submit.js"',
    PostToolUse: 'node "/checkout/dist/hooks/post-tool-use.js"',
    PreCompact: 'node "/checkout/dist/hooks/pre-compact.js"',
  };
  const status = 'node "/checkout/dist/hooks/status.js"';

  it("is idempotent even when the install path doesn't name the package", () => {
    const settings: Record<string, unknown> = {};
    applyClaudeHooks(settings, ours, status);
    applyClaudeHooks(settings, ours, status);
    expect(commands(settings as Settings, "UserPromptSubmit")).toEqual([ours.UserPromptSubmit]);
    expect((settings as Settings).statusLine?.command).toBe(status);
  });
});

describe("reconcileAll — Claude Code", () => {
  it("keeps user hooks, including ones sharing a matcher group with DietCode's", () => {
    writeSettings({
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: `node "${OLD_DIETCODE}/user-prompt-submit.js"` },
              USER_PROMPT_HOOK,
            ],
          },
        ],
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "~/bin/audit.sh" }] },
          { matcher: "", hooks: [{ type: "command", command: `node "${OLD_DIETCODE}/post-tool-use.js"` }] },
        ],
      },
    });

    reconcileAll();
    reconcileAll(); // idempotent: no duplicated DietCode entries

    const s = readSettings();
    const prompt = commands(s, "UserPromptSubmit");
    expect(prompt).toContain(USER_PROMPT_HOOK.command);
    expect(prompt.filter((c) => c.includes("user-prompt-submit.js"))).toHaveLength(1);
    expect(prompt).not.toContain(`node "${OLD_DIETCODE}/user-prompt-submit.js"`);

    const post = commands(s, "PostToolUse");
    expect(post).toContain("~/bin/audit.sh");
    expect(post.filter((c) => c.includes("post-tool-use.js"))).toHaveLength(1);
    expect(s.hooks?.PostToolUse[0].matcher).toBe("Bash");

    expect(commands(s, "PreCompact").filter((c) => c.includes("pre-compact.js"))).toHaveLength(1);
  });

  it("leaves a user-configured statusLine alone", () => {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: `node "${OLD_DIETCODE}/user-prompt-submit.js"` }] }] },
      statusLine: USER_STATUS,
    });
    reconcileAll();
    expect(readSettings().statusLine).toEqual(USER_STATUS);
  });

  it("refreshes DietCode's own statusLine", () => {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: `node "${OLD_DIETCODE}/user-prompt-submit.js"` }] }] },
      statusLine: { type: "command", command: `node "${OLD_DIETCODE}/status.js"` },
    });
    reconcileAll();
    expect(readSettings().statusLine?.command).toMatch(/status\.js/);
    expect(readSettings().statusLine?.command).not.toContain(OLD_DIETCODE);
  });

  it("never adds CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, even after the user removed it", () => {
    const prev = process.env.SCALEDOWN_COMPACT_THRESHOLD;
    delete process.env.SCALEDOWN_COMPACT_THRESHOLD;
    try {
      writeSettings({
        hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: `node "${OLD_DIETCODE}/user-prompt-submit.js"` }] }] },
        env: { OTHER: "1" },
      });
      reconcileAll();
      expect(readSettings().env).toEqual({ OTHER: "1" });
    } finally {
      if (prev !== undefined) process.env.SCALEDOWN_COMPACT_THRESHOLD = prev;
    }
  });

  it("keeps an existing user-chosen autocompact value untouched", () => {
    writeSettings({
      hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: `node "${OLD_DIETCODE}/user-prompt-submit.js"` }] }] },
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" },
    });
    reconcileAll();
    expect(readSettings().env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("80");
  });

  it("does nothing for a user who never set DietCode up", () => {
    const untouched = { hooks: { UserPromptSubmit: [{ matcher: "", hooks: [USER_PROMPT_HOOK] }] } };
    writeSettings(untouched);
    expect(reconcileAll().claude).toBe(false);
    expect(readSettings()).toEqual(untouched);
  });
});

describe("uninstallAll — Claude Code", () => {
  it("removes only DietCode's commands from shared matcher groups", () => {
    writeSettings({
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: `node "${OLD_DIETCODE}/user-prompt-submit.js"` },
              USER_PROMPT_HOOK,
            ],
          },
        ],
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: `node "${OLD_DIETCODE}/pre-compact.js"` }] }],
      },
      statusLine: USER_STATUS,
    });

    uninstallAll();

    const s = readSettings();
    expect(s.hooks?.UserPromptSubmit).toEqual([{ matcher: "", hooks: [USER_PROMPT_HOOK] }]);
    expect(s.hooks?.PreCompact).toBeUndefined();
    expect(s.statusLine).toEqual(USER_STATUS);
  });
});
