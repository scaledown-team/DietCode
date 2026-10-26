import { jest } from "@jest/globals";
import type { CompressResponse, SummarizeResponse } from "../src/client.js";
import {
  extractText,
  replaceText,
  postToolUseOutput,
  processToolResponse,
  detectCommandType,
  filterLsOutput,
  filterGrepOutput,
  compactGitDiff,
  filterGitLog,
  filterGitStatus,
} from "./post-tool-use.js";

const COMPRESS_RESPONSE: CompressResponse = {
  compressed_prompt: "compressed tool output",
  original_prompt_tokens: 5000,
  compressed_prompt_tokens: 1500,
  successful: true,
  latency_ms: 80,
  request_metadata: {
    compression_time_ms: 80,
    compression_rate: 0.3,
    prompt_length: 20000,
    compressed_prompt_length: 6000,
  },
};

const CONFIG = { postToolDisable: false, postToolThreshold: 4000, postToolLocalOnly: false, compressRate: 0.3 as const };

function fakeClient() {
  return {
    compress: jest.fn<() => Promise<CompressResponse>>().mockResolvedValue(COMPRESS_RESPONSE),
    summarize: jest.fn<() => Promise<SummarizeResponse>>().mockResolvedValue({
      summary: "short summary",
      input_chars: 20000,
      output_chars: 13,
      latency_ms: 50,
    }),
  };
}

// Tool response shapes as Claude Code passes them to PostToolUse hooks.
function bashResponse(stdout: string, extra: Record<string, unknown> = {}) {
  return { stdout, stderr: "warning: something", interrupted: false, isImage: false, noOutputExpected: false, ...extra };
}

function readResponse(content: string) {
  return {
    type: "text",
    file: { filePath: "/repo/notes.md", content, numLines: 3, startLine: 1, totalLines: 3 },
  };
}

const LS_OUTPUT = [
  "total 48",
  "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 src",
  "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 node_modules",
  "-rw-r--r--  1 user  staff  1234 Jan  1 12:00 package.json",
].join("\n");

const LARGE = "line of generic build output that is not structurally filtered\n".repeat(400);

describe("extractText", () => {
  it("handles plain string response", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("extracts stdout from Claude Code's Bash response", () => {
    expect(extractText(bashResponse("bash output"))).toBe("bash output");
  });

  it("does not treat Bash image output as text", () => {
    expect(extractText(bashResponse("iVBORw0KGgo=", { isImage: true }))).toBeNull();
  });

  it("extracts file.content from Claude Code's Read response", () => {
    expect(extractText(readResponse("# Notes"))).toBe("# Notes");
  });

  it("extracts output field", () => {
    expect(extractText({ output: "bash output", exit_code: 0 })).toBe("bash output");
  });

  it("extracts content field", () => {
    expect(extractText({ content: "file contents" })).toBe("file contents");
  });

  it("extracts text field", () => {
    expect(extractText({ text: "some text" })).toBe("some text");
  });

  it("returns null for unrecognized shape", () => {
    expect(extractText({ unknown: 42 })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractText(null)).toBeNull();
  });
});

describe("replaceText", () => {
  it("replaces plain string", () => {
    expect(replaceText("original", "new")).toBe("new");
  });

  it("replaces Bash stdout and preserves stderr and execution status", () => {
    const original = bashResponse("old", { interrupted: true });
    expect(replaceText(original, "new")).toEqual({ ...original, stdout: "new" });
  });

  it("leaves Bash image output untouched", () => {
    const original = bashResponse("iVBORw0KGgo=", { isImage: true });
    expect(replaceText(original, "new")).toBe(original);
  });

  it("replaces Read file.content and preserves file metadata", () => {
    const original = readResponse("old");
    expect(replaceText(original, "new")).toEqual({
      type: "text",
      file: { ...original.file, content: "new" },
    });
  });

  it("replaces output field, preserves other fields", () => {
    const result = replaceText({ output: "old", exit_code: 0 }, "new") as Record<string, unknown>;
    expect(result.output).toBe("new");
    expect(result.exit_code).toBe(0);
  });

  it("replaces content field", () => {
    const result = replaceText({ content: "old" }, "new") as Record<string, unknown>;
    expect(result.content).toBe("new");
  });

  it("returns response unchanged if no recognized field", () => {
    const resp = { unknown: 42 };
    expect(replaceText(resp, "new")).toBe(resp);
  });
});

describe("postToolUseOutput", () => {
  it("nests the replacement under hookSpecificOutput.updatedToolOutput", () => {
    expect(postToolUseOutput({ stdout: "x" })).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: "x" } },
    });
  });
});

describe("processToolResponse", () => {
  it("structurally filters Bash ls output without calling Scaledown", async () => {
    const client = fakeClient();
    const original = bashResponse(LS_OUTPUT);
    const result = await processToolResponse(
      { tool_name: "Bash", tool_input: { command: "ls -l" }, tool_response: original },
      CONFIG,
      client
    );
    const updated = result.updatedToolOutput as ReturnType<typeof bashResponse>;
    expect(updated.stdout).toContain("Summary: 1 files, 1 dirs");
    expect(updated.stdout).not.toContain("drwxr-xr-x");
    expect(updated.stderr).toBe(original.stderr);
    expect(updated.interrupted).toBe(false);
    expect(result.saved).toBeGreaterThan(0);
    expect(result.requests).toBe(0);
    expect(client.compress).not.toHaveBeenCalled();
  });

  it("compresses large Bash output and replaces stdout rather than appending", async () => {
    const client = fakeClient();
    const result = await processToolResponse(
      { tool_name: "Bash", tool_input: { command: "npm run build" }, tool_response: bashResponse(LARGE) },
      CONFIG,
      client
    );
    expect(client.compress).toHaveBeenCalledTimes(1);
    expect(result.updatedToolOutput).toEqual(bashResponse("compressed tool output"));
    expect(result.saved).toBe(3500);
    expect(result.requests).toBe(1);
  });

  it("summarizes large non-code Read output into file.content", async () => {
    const client = fakeClient();
    const result = await processToolResponse(
      { tool_name: "Read", tool_input: { file_path: "/repo/notes.md" }, tool_response: readResponse(LARGE) },
      CONFIG,
      client
    );
    expect(client.summarize).toHaveBeenCalledTimes(1);
    const updated = result.updatedToolOutput as ReturnType<typeof readResponse>;
    expect(updated.file.content).toBe("short summary");
    expect(updated.file.filePath).toBe("/repo/notes.md");
    expect(result.requests).toBe(1);
  });

  it("compresses large MCP-style text output", async () => {
    const client = fakeClient();
    const result = await processToolResponse(
      { tool_name: "mcp__docs__fetch", tool_input: {}, tool_response: { content: LARGE } },
      CONFIG,
      client
    );
    expect(result.updatedToolOutput).toEqual({ content: "compressed tool output" });
  });

  it("leaves small unfiltered output untouched", async () => {
    const client = fakeClient();
    const result = await processToolResponse(
      { tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: bashResponse("hi\n") },
      CONFIG,
      client
    );
    expect(result).toEqual({ updatedToolOutput: null, saved: 0, requests: 0 });
    expect(client.compress).not.toHaveBeenCalled();
  });

  it("leaves output untouched and books nothing when compression fails", async () => {
    const client = fakeClient();
    client.compress.mockRejectedValueOnce(new Error("api error") as never);
    const result = await processToolResponse(
      { tool_name: "Bash", tool_input: { command: "npm run build" }, tool_response: bashResponse(LARGE) },
      CONFIG,
      client
    );
    expect(result).toEqual({ updatedToolOutput: null, saved: 0, requests: 0 });
  });

  it("does nothing when disabled", async () => {
    const client = fakeClient();
    const result = await processToolResponse(
      { tool_name: "Bash", tool_input: { command: "ls -l" }, tool_response: bashResponse(LS_OUTPUT) },
      { ...CONFIG, postToolDisable: true },
      client
    );
    expect(result.updatedToolOutput).toBeNull();
  });
});

describe("detectCommandType", () => {
  it("detects ls", () => {
    expect(detectCommandType("Bash", { command: "ls -la ." })).toBe("ls");
    expect(detectCommandType("Bash", { command: "ls" })).toBe("ls");
  });

  it("detects grep", () => {
    expect(detectCommandType("Bash", { command: "grep -r 'foo' ." })).toBe("grep");
    expect(detectCommandType("Bash", { command: "rg 'bar' src/" })).toBe("grep");
    expect(detectCommandType("Bash", { command: "git grep 'baz'" })).toBe("grep");
  });

  it("detects git diff and git show", () => {
    expect(detectCommandType("Bash", { command: "git diff HEAD~1" })).toBe("git-diff");
    expect(detectCommandType("Bash", { command: "git show abc1234" })).toBe("git-diff");
  });

  it("detects git log", () => {
    expect(detectCommandType("Bash", { command: "git log -10" })).toBe("git-log");
    expect(detectCommandType("Bash", { command: "git log --oneline" })).toBe("git-log");
  });

  it("detects git status", () => {
    expect(detectCommandType("Bash", { command: "git status" })).toBe("git-status");
    expect(detectCommandType("Bash", { command: "git status --short" })).toBe("git-status");
  });

  it("detects Read tool", () => {
    expect(detectCommandType("Read", { file_path: "README.md" })).toBe("read");
  });

  it("returns generic for unknown commands", () => {
    expect(detectCommandType("Bash", { command: "npm install" })).toBe("generic");
    expect(detectCommandType("Bash", { command: "cargo build" })).toBe("generic");
  });

  it("returns generic for non-Bash/Read tools", () => {
    expect(detectCommandType("Write", {})).toBe("generic");
    expect(detectCommandType("Edit", {})).toBe("generic");
  });
});

describe("filterLsOutput", () => {
  const basicLs = [
    "total 48",
    "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 .",
    "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 ..",
    "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 src",
    "drwxr-xr-x  2 user  staff    64 Jan  1 12:00 node_modules",
    "-rw-r--r--  1 user  staff  1234 Jan  1 12:00 package.json",
    "-rw-r--r--  1 user  staff  5678 Jan  1 12:00 README.md",
  ].join("\n");

  it("shows dirs with trailing slash, files with size", () => {
    const result = filterLsOutput(basicLs);
    expect(result).toContain("src/");
    expect(result).toContain("package.json  1.2K");
    expect(result).toContain("README.md  5.5K");
  });

  it("strips permissions, owner, group, and date", () => {
    const result = filterLsOutput(basicLs);
    expect(result).not.toContain("drwxr-xr-x");
    expect(result).not.toContain("staff");
    expect(result).not.toContain("Jan");
  });

  it("filters noise dirs by default", () => {
    expect(filterLsOutput(basicLs)).not.toContain("node_modules");
  });

  it("shows noise dirs with showAll=true", () => {
    expect(filterLsOutput(basicLs, true)).toContain("node_modules/");
  });

  it("includes summary line", () => {
    const result = filterLsOutput(basicLs);
    expect(result).toContain("Summary: 2 files, 1 dirs");
  });

  it("falls back to original on unparseable input", () => {
    const garbage = "some random text\nnot ls output at all";
    expect(filterLsOutput(garbage)).toBe(garbage);
  });

  it("returns (empty) for directory with only . and ..", () => {
    const empty = [
      "total 0",
      "drwxr-xr-x  2 user staff  64 Jan  1 12:00 .",
      "drwxr-xr-x 16 user staff 512 Jan  1 12:00 ..",
    ].join("\n");
    expect(filterLsOutput(empty)).toBe("(empty)\n");
  });

  it("handles symlinks", () => {
    const withLink = "lrwxr-xr-x  1 user  staff  10 Jan  1 12:00 link -> target\n";
    const result = filterLsOutput(withLink);
    expect(result).toContain("link -> target");
  });
});

describe("filterGrepOutput", () => {
  const grepOutput = [
    "src/foo.ts:10:  const x = 1;",
    "src/foo.ts:20:  const y = 2;",
    "src/bar.ts:5:  import { x } from './foo';",
  ].join("\n");

  it("shows match count header", () => {
    const result = filterGrepOutput(grepOutput);
    expect(result).toContain("3 matches in 2 files:");
  });

  it("preserves file:line:content format", () => {
    const result = filterGrepOutput(grepOutput);
    expect(result).toContain("src/foo.ts:10:");
    expect(result).toContain("src/bar.ts:5:");
  });

  it("truncates very long lines", () => {
    const longContent = "a".repeat(200);
    const longLine = `src/x.ts:1:${longContent}`;
    const result = filterGrepOutput(longLine);
    const matchLine = result.split("\n").find((l) => l.startsWith("src/x.ts"));
    expect(matchLine).toBeDefined();
    // file:line: prefix (12 chars) + 120 content chars + "..." = at most ~135
    expect(matchLine!.length).toBeLessThanOrEqual(140);
  });

  it("returns original text when no file:line:content matches", () => {
    const noMatches = "no matches here, just plain text";
    expect(filterGrepOutput(noMatches)).toBe(noMatches);
  });

  it("shows overflow notice when max per-file exceeded", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `src/big.ts:${i + 1}:hit`).join("\n");
    const result = filterGrepOutput(lines);
    expect(result).toContain("[+5 more in this file]");
  });
});

describe("compactGitDiff", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1234567..abcdefg 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,5 +1,6 @@ function foo() {",
    " context line",
    "-old line",
    "+new line",
    "+added line",
    " context line",
  ].join("\n");

  it("shows file header", () => {
    expect(compactGitDiff(diff)).toContain("src/foo.ts");
  });

  it("preserves hunk header line", () => {
    expect(compactGitDiff(diff)).toContain("@@ -1,5 +1,6 @@");
  });

  it("includes changed lines", () => {
    const result = compactGitDiff(diff);
    expect(result).toContain("+new line");
    expect(result).toContain("-old line");
  });

  it("shows +N -N change counts per file", () => {
    expect(compactGitDiff(diff)).toContain("+2 -1");
  });

  it("adds truncation notice and recovery hint for large diffs", () => {
    const hugeDiff = [
      "diff --git a/big.ts b/big.ts",
      "@@ -1,200 +1,200 @@",
      ...Array.from({ length: 150 }, (_, i) => `+line ${i}`),
    ].join("\n");
    const result = compactGitDiff(hugeDiff);
    expect(result).toContain("lines truncated");
    expect(result).toContain("[full diff: git diff --no-compact]");
  });
});

describe("filterGitLog", () => {
  const verboseLog = [
    "commit abc123456789012345678901234567890",
    "Author: Jane Doe <jane@example.com>",
    "Date:   Mon May 12 10:00:00 2026 +0000",
    "",
    "    feat: add new feature",
    "",
    "commit def987654321098765432109876543210",
    "Author: John Smith <john@example.com>",
    "Date:   Sun May 11 09:00:00 2026 +0000",
    "",
    "    fix: resolve bug in parser",
  ].join("\n");

  it("collapses verbose log to one line per commit", () => {
    const result = filterGitLog(verboseLog);
    const lines = result.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2);
  });

  it("includes short hash, message, and author", () => {
    const result = filterGitLog(verboseLog);
    expect(result).toContain("abc12345");
    expect(result).toContain("feat: add new feature");
    expect(result).toContain("Jane Doe");
  });

  it("passes through compact one-line format unchanged (just truncates)", () => {
    const compact = "abc1234 feat: something (2 days ago) <jane@example.com>";
    const result = filterGitLog(compact);
    expect(result).toContain("abc1234");
  });

  it("truncates very long lines in compact format", () => {
    const longLine = "abc1234 " + "x".repeat(200);
    const result = filterGitLog(longLine);
    expect(result.length).toBeLessThan(longLine.length);
    expect(result).toContain("...");
  });
});

describe("filterGitStatus", () => {
  const statusWithHints = [
    "\x1b[32mOn branch main\x1b[0m",
    "",
    "hint: use git add to stage changes",
    "hint: another hint line",
    "Changes not staged for commit:",
    "  \x1b[31mmodified:   src/foo.ts\x1b[0m",
  ].join("\n");

  it("strips ANSI escape codes", () => {
    expect(filterGitStatus(statusWithHints)).not.toContain("\x1b[");
  });

  it("removes hint lines", () => {
    expect(filterGitStatus(statusWithHints)).not.toContain("hint:");
  });

  it("removes blank lines", () => {
    const result = filterGitStatus(statusWithHints);
    expect(result.split("\n").every((l) => l.trim())).toBe(true);
  });

  it("preserves changed file lines", () => {
    expect(filterGitStatus(statusWithHints)).toContain("modified:   src/foo.ts");
  });

  it("preserves branch info", () => {
    expect(filterGitStatus(statusWithHints)).toContain("On branch main");
  });
});
