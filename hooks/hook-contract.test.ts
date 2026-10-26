/**
 * Hook stdin/stdout contract tests — runs the built hooks (dist/hooks/*.js) as
 * Claude Code does: JSON on stdin, JSON on stdout. Uses a temporary HOME (so
 * stats never touch the real ~/.scaledown) and a local stub Scaledown API.
 *
 * Requires `npm run build`; skipped when dist/ is missing.
 */
import { execFile } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join, resolve } from "path";

const DIST_HOOKS = resolve(process.cwd(), "dist", "hooks");
const describeIfBuilt = existsSync(join(DIST_HOOKS, "post-tool-use.js")) ? describe : describe.skip;

let server: http.Server;
let baseUrl = "";
let failApi = false;
const apiCalls: string[] = [];
let home = "";

function respond(path: string): unknown {
  if (path.startsWith("/classify")) {
    return { top_label: "search", scores: { search: 0.82 }, labels: [] };
  }
  if (path.startsWith("/summarization")) {
    return { summary: "short summary", input_chars: 20000, output_chars: 13, latency_ms: 1 };
  }
  return {
    results: { compressed_prompt: "compressed tool output", original_prompt_tokens: 5000, compressed_prompt_tokens: 1500 },
    successful: true,
    latency_ms: 1,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      apiCalls.push(req.url ?? "");
      if (failApi) {
        res.writeHead(500).end("boom");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(respond(req.url ?? "/")));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dietcode-hook-"));
  apiCalls.length = 0;
  failApi = false;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function runHook(
  name: string,
  input: unknown,
  env: Record<string, string | undefined> = {}
): Promise<{ stdout: string; json: Record<string, unknown> }> {
  return new Promise((done, fail) => {
    const child = execFile(
      process.execPath,
      [join(DIST_HOOKS, name)],
      {
        // Drop undefined entries so a test can unset a variable (e.g. the API key).
        env: Object.fromEntries(
          Object.entries({
            PATH: process.env.PATH,
            HOME: home,
            USERPROFILE: home,
            SCALEDOWN_API_KEY: "test-key",
            SCALEDOWN_BASE_URL: baseUrl,
            ...env,
          }).filter(([, v]) => v !== undefined)
        ) as NodeJS.ProcessEnv,
        timeout: 15000,
      },
      (err, stdout) => {
        if (err) return fail(err);
        done({ stdout, json: JSON.parse(stdout) });
      }
    );
    child.stdin!.end(JSON.stringify(input));
  });
}

function savedTokens(): number {
  const file = join(home, ".scaledown", "stats.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).totalSaved : 0;
}

const LARGE = "line of generic build output that is not structurally filtered\n".repeat(400);

function bash(command: string, stdout: string) {
  return {
    session_id: "s1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout, stderr: "warn", interrupted: false, isImage: false, noOutputExpected: false },
  };
}

describeIfBuilt("PostToolUse hook contract", () => {
  it("replaces Bash stdout via hookSpecificOutput.updatedToolOutput", async () => {
    const { json } = await runHook("post-tool-use.js", bash("npm run build", LARGE));
    expect(json).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: { stdout: "compressed tool output", stderr: "warn", interrupted: false, isImage: false, noOutputExpected: false },
      },
    });
    expect(json).not.toHaveProperty("tool_response");
    expect(apiCalls).toEqual(["/compress/raw/"]);
    expect(savedTokens()).toBe(3500);
  }, 20000);

  it("replaces Read file.content and keeps file metadata", async () => {
    const { json } = await runHook("post-tool-use.js", {
      session_id: "s1",
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/repo/notes.md" },
      tool_response: { type: "text", file: { filePath: "/repo/notes.md", content: LARGE, numLines: 400, startLine: 1, totalLines: 400 } },
    });
    const updated = (json.hookSpecificOutput as Record<string, unknown>).updatedToolOutput as Record<string, unknown>;
    expect(updated).toEqual({
      type: "text",
      file: { filePath: "/repo/notes.md", content: "short summary", numLines: 400, startLine: 1, totalLines: 400 },
    });
  }, 20000);

  it("emits {} and books nothing for small output", async () => {
    const { json } = await runHook("post-tool-use.js", bash("echo hi", "hi\n"));
    expect(json).toEqual({});
    expect(apiCalls).toEqual([]);
    expect(savedTokens()).toBe(0);
  }, 20000);

  it("emits {} and books nothing when the API fails", async () => {
    failApi = true;
    const { json } = await runHook("post-tool-use.js", bash("npm run build", LARGE));
    expect(json).toEqual({});
    expect(savedTokens()).toBe(0);
  }, 20000);
});

describeIfBuilt("UserPromptSubmit hook contract", () => {
  it("adds the intent hint as additionalContext and never returns a prompt", async () => {
    const prompt = `${"a ".repeat(30000)} find the function that handles auth`;
    const { json } = await runHook("user-prompt-submit.js", {
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt,
    });
    expect(json).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "[DietCode intent: search (82%)]",
      },
    });
    expect(apiCalls).toEqual(["/classify"]);
    expect(savedTokens()).toBe(0);
  }, 20000);

  it("emits {} when classification fails", async () => {
    failApi = true;
    const { json } = await runHook("user-prompt-submit.js", { session_id: "s1", prompt: "hello" });
    expect(json).toEqual({});
  }, 20000);
});

const LS_OUTPUT = [
  "total 48",
  "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 src",
  "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 node_modules",
  "-rw-r--r--  1 user  staff  1234 Jan  1 12:00 package.json",
].join("\n");

function filteredStdout(json: Record<string, unknown>): string {
  const out = json.hookSpecificOutput as { updatedToolOutput: { stdout: string } };
  return out.updatedToolOutput.stdout;
}

describeIfBuilt("per-stage cloud controls (no request when disabled)", () => {
  it("SCALEDOWN_CLASSIFY_DISABLE: prompt is never sent", async () => {
    const { json } = await runHook(
      "user-prompt-submit.js",
      { session_id: "s1", prompt: "find the auth handler" },
      { SCALEDOWN_CLASSIFY_DISABLE: "true" }
    );
    expect(json).toEqual({});
    expect(apiCalls).toEqual([]);
  }, 20000);

  it("SCALEDOWN_CLASSIFY_DISABLE leaves tool-output compression on", async () => {
    const { json } = await runHook("post-tool-use.js", bash("npm run build", LARGE), {
      SCALEDOWN_CLASSIFY_DISABLE: "true",
    });
    expect(filteredStdout(json)).toBe("compressed tool output");
    expect(apiCalls).toEqual(["/compress/raw/"]);
  }, 20000);

  it("SCALEDOWN_POST_TOOL_LOCAL_ONLY: large output stays local and unchanged", async () => {
    const { json } = await runHook("post-tool-use.js", bash("npm run build", LARGE), {
      SCALEDOWN_POST_TOOL_LOCAL_ONLY: "true",
    });
    expect(json).toEqual({});
    expect(apiCalls).toEqual([]);
  }, 20000);

  it("SCALEDOWN_POST_TOOL_LOCAL_ONLY still applies the structural filter", async () => {
    const { json } = await runHook("post-tool-use.js", bash("ls -l", LS_OUTPUT), {
      SCALEDOWN_POST_TOOL_LOCAL_ONLY: "true",
    });
    expect(filteredStdout(json)).toContain("Summary: 1 files, 1 dirs");
    expect(apiCalls).toEqual([]);
  }, 20000);

  describe("SCALEDOWN_LOCAL_ONLY without an API key", () => {
    const LOCAL = { SCALEDOWN_LOCAL_ONLY: "true", SCALEDOWN_API_KEY: undefined };

    it("UserPromptSubmit makes no request", async () => {
      const { json } = await runHook("user-prompt-submit.js", { session_id: "s1", prompt: "hi" }, LOCAL);
      expect(json).toEqual({});
      expect(apiCalls).toEqual([]);
    }, 20000);

    it("PostToolUse filters ls output locally", async () => {
      const { json } = await runHook("post-tool-use.js", bash("ls -l", LS_OUTPUT), LOCAL);
      expect(filteredStdout(json)).toContain("Summary: 1 files, 1 dirs");
      expect(apiCalls).toEqual([]);
    }, 20000);

    it("PostToolUse never sends large output", async () => {
      const { json } = await runHook("post-tool-use.js", bash("npm run build", LARGE), LOCAL);
      expect(json).toEqual({});
      expect(apiCalls).toEqual([]);
    }, 20000);
  });
});
