#!/usr/bin/env node
import { ScaledownClient } from "../src/client.js";
import { loadConfig, type Config } from "../src/config.js";
import { estimateTokens } from "../src/niah.js";
import { addRequest, addSaving } from "../src/stats.js";

type CommandType =
  | "ls"
  | "grep"
  | "git-diff"
  | "git-log"
  | "git-status"
  | "read"
  | "generic";

export interface HookInput {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  session_id?: string;
  [key: string]: unknown;
}

const LS_NOISE_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  ".cache",
  "build",
  "coverage",
  ".nyc_output",
  ".turbo",
  ".parcel-cache",
]);

const LS_DATE_RE =
  /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2})\s+/;

// Extensions where lossless compression beats abstractive summarization.
// For everything else (logs, markdown, plain text), summarize is better.
const CODE_EXTENSIONS = new Set([
  ".ts", ".js", ".tsx", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".html", ".css", ".scss", ".sass", ".less",
  ".sql", ".graphql", ".proto", ".tf", ".hcl", ".nix",
]);

// Extracts the primary text content from a tool response.
// Handles Claude Code's Bash {stdout, stderr, ...} and Read
// {type: "text", file: {content, ...}} shapes, plus plain strings and the
// generic {output}/{content}/{text} shapes used by other tools.
export function extractText(toolResponse: unknown): string | null {
  if (typeof toolResponse === "string") return toolResponse;
  if (toolResponse !== null && typeof toolResponse === "object") {
    const r = toolResponse as Record<string, unknown>;
    if (typeof r.stdout === "string") {
      // Image output is base64 data, not text — never rewrite it.
      return r.isImage === true ? null : r.stdout;
    }
    const file = readFileField(r);
    if (file) return file.content as string;
    if (typeof r.output === "string") return r.output;
    if (typeof r.content === "string") return r.content;
    if (typeof r.text === "string") return r.text;
  }
  return null;
}

// Returns a new tool_response with the text field replaced by newText, keeping
// every other field (stderr, interrupted, file metadata, ...) unchanged so the
// result still matches the tool's output shape.
export function replaceText(toolResponse: unknown, newText: string): unknown {
  if (typeof toolResponse === "string") return newText;
  if (toolResponse !== null && typeof toolResponse === "object") {
    const r = toolResponse as Record<string, unknown>;
    if (typeof r.stdout === "string") {
      return r.isImage === true ? toolResponse : { ...r, stdout: newText };
    }
    const file = readFileField(r);
    if (file) return { ...r, file: { ...file, content: newText } };
    if (typeof r.output === "string") return { ...r, output: newText };
    if (typeof r.content === "string") return { ...r, content: newText };
    if (typeof r.text === "string") return { ...r, text: newText };
  }
  return toolResponse;
}

function readFileField(r: Record<string, unknown>): Record<string, unknown> | null {
  if (r.type !== "text" || r.file === null || typeof r.file !== "object") return null;
  const file = r.file as Record<string, unknown>;
  return typeof file.content === "string" ? file : null;
}

// Builds the hook's stdout per the Claude Code PostToolUse contract: the
// replacement must be nested under hookSpecificOutput.updatedToolOutput and
// match the tool's own output shape (a top-level `tool_response` is ignored).
export function postToolUseOutput(updatedToolOutput: unknown): {
  hookSpecificOutput: { hookEventName: "PostToolUse"; updatedToolOutput: unknown };
} {
  return {
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput },
  };
}

export function detectCommandType(
  toolName: string,
  toolInput: unknown
): CommandType {
  if (toolName === "Read") return "read";

  if (toolName === "Bash" && toolInput !== null && typeof toolInput === "object") {
    const cmd = (toolInput as Record<string, unknown>).command;
    if (typeof cmd === "string") {
      const trimmed = cmd.trim();
      if (/^ls(\s|$)/.test(trimmed)) return "ls";
      if (/^(grep|rg)\s/.test(trimmed) || /^git\s+grep\b/.test(trimmed))
        return "grep";
      if (/^git\s+(diff|show)\b/.test(trimmed)) return "git-diff";
      if (/^git\s+log\b/.test(trimmed)) return "git-log";
      if (/^git\s+status\b/.test(trimmed)) return "git-status";
    }
  }

  return "generic";
}

function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

// Compact `ls -l` output: strips permissions/owner/group/date, filters noise
// dirs, keeps name and size. Falls back to original if parsing fails.
export function filterLsOutput(text: string, showAll = false): string {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];
  // validLines: lines matching ls date format (including . and ..)
  // used to distinguish "not ls output" from "empty directory"
  let validLines = 0;

  for (const line of text.split("\n")) {
    if (!line || line.startsWith("total ")) continue;

    const dateMatch = LS_DATE_RE.exec(line);
    if (!dateMatch) continue;

    validLines++;

    const name = line.slice(dateMatch.index + dateMatch[0].length).trim();
    if (name === "." || name === "..") continue;

    const before = line.slice(0, dateMatch.index);
    const parts = before.trim().split(/\s+/);
    if (parts.length < 2 || !parts[0]) continue;

    const fileType = parts[0][0];
    let size = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const n = parseInt(parts[i], 10);
      if (!isNaN(n)) {
        size = n;
        break;
      }
    }

    if (fileType === "d") {
      if (!showAll && LS_NOISE_DIRS.has(name)) continue;
      dirs.push(name);
    } else {
      files.push([name, humanSize(size)]);
    }
  }

  if (validLines === 0) return text;
  if (dirs.length === 0 && files.length === 0) return "(empty)\n";

  let out = "";
  for (const d of dirs) out += `${d}/\n`;
  for (const [name, size] of files) out += `${name}  ${size}\n`;
  out += `\nSummary: ${files.length} files, ${dirs.length} dirs\n`;
  return out;
}

// Groups grep/rg output by file, truncates long lines, shows match count header.
export function filterGrepOutput(text: string): string {
  const MAX_LINE_LEN = 120;
  const MAX_PER_FILE = 20;
  const MAX_TOTAL = 200;

  const byFile = new Map<string, Array<[number, string]>>();
  let total = 0;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const colonIdx1 = line.indexOf(":");
    if (colonIdx1 === -1) continue;
    const colonIdx2 = line.indexOf(":", colonIdx1 + 1);
    if (colonIdx2 === -1) continue;

    const file = line.slice(0, colonIdx1);
    const lineNum = parseInt(line.slice(colonIdx1 + 1, colonIdx2), 10);
    if (isNaN(lineNum)) continue;
    const content = line.slice(colonIdx2 + 1).trim();

    total++;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push([lineNum, content]);
  }

  if (total === 0) return text;

  let out = `${total} matches in ${byFile.size} files:\n\n`;
  let shown = 0;

  for (const [file, matches] of [...byFile.entries()].sort()) {
    if (shown >= MAX_TOTAL) break;
    for (const [lineNum, content] of matches.slice(0, MAX_PER_FILE)) {
      if (shown >= MAX_TOTAL) break;
      const truncated =
        content.length > MAX_LINE_LEN
          ? content.slice(0, MAX_LINE_LEN - 3) + "..."
          : content;
      out += `${file}:${lineNum}:${truncated}\n`;
      shown++;
    }
    if (matches.length > MAX_PER_FILE) {
      out += `  [+${matches.length - MAX_PER_FILE} more in this file]\n`;
    }
  }

  if (total > shown) out += `[+${total - shown} more matches]\n`;
  return out;
}

// Compacts unified diff: shows file headers, hunk anchors, +/- lines up to
// 100 per hunk, then counts. Mirrors rtk's compact_diff logic.
export function compactGitDiff(text: string): string {
  const MAX_LINES = 500;
  const MAX_HUNK_LINES = 100;

  const result: string[] = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      if (currentFile && (added > 0 || removed > 0)) {
        result.push(`  +${added} -${removed}`);
      }
      currentFile = line.split(" b/")[1] ?? "unknown";
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      inHunk = true;
      hunkShown = 0;
      result.push(`  ${line}`);
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added++;
        if (hunkShown < MAX_HUNK_LINES) {
          result.push(`  ${line}`);
          hunkShown++;
        } else {
          hunkSkipped++;
        }
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed++;
        if (hunkShown < MAX_HUNK_LINES) {
          result.push(`  ${line}`);
          hunkShown++;
        } else {
          hunkSkipped++;
        }
      } else if (!line.startsWith("\\") && hunkShown > 0 && hunkShown < MAX_HUNK_LINES) {
        result.push(`  ${line}`);
        hunkShown++;
      }
    }

    if (result.length >= MAX_LINES) {
      result.push("\n... (more changes truncated)");
      wasTruncated = true;
      break;
    }
  }

  if (hunkSkipped > 0) {
    result.push(`  ... (${hunkSkipped} lines truncated)`);
    wasTruncated = true;
  }
  if (currentFile && (added > 0 || removed > 0)) {
    result.push(`  +${added} -${removed}`);
  }
  if (wasTruncated) {
    result.push("[full diff: git diff --no-compact]");
  }

  return result.join("\n");
}

function formatCommitBlock(lines: string[]): string {
  const hash = lines[0]?.replace("commit ", "").slice(0, 8) ?? "";
  const authorLine = lines.find((l) => l.startsWith("Author:")) ?? "";
  const dateLine = lines.find((l) => l.startsWith("Date:")) ?? "";
  const msgLine =
    lines
      .find(
        (l) =>
          l.trim() &&
          !l.startsWith("commit") &&
          !l.startsWith("Author:") &&
          !l.startsWith("Date:") &&
          !l.startsWith("Merge:")
      )
      ?.trim() ?? "";

  const author =
    authorLine.replace("Author:", "").trim().split("<")[0]?.trim() ?? "";
  const date = dateLine.replace("Date:", "").trim().slice(0, 20);
  const msg = msgLine.length > 80 ? msgLine.slice(0, 77) + "..." : msgLine;

  if (!hash) return "";
  return `${hash} ${msg} (${date}) <${author}>`;
}

// Collapses verbose `git log` blocks to one line per commit. Passes through
// compact/custom formats unchanged (just truncates long lines).
export function filterGitLog(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return text;

  if (lines[0]?.startsWith("commit ")) {
    const commits: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (line.startsWith("commit ") && current.length > 0) {
        const formatted = formatCommitBlock(current);
        if (formatted) commits.push(formatted);
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) {
      const formatted = formatCommitBlock(current);
      if (formatted) commits.push(formatted);
    }

    return commits.join("\n");
  }

  return lines
    .map((l) => (l.length > 120 ? l.slice(0, 117) + "..." : l))
    .join("\n");
}

// Strips ANSI codes and git hint lines from `git status` output.
export function filterGitStatus(text: string): string {
  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  const result: string[] = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("hint:") || !line.trim()) continue;
    result.push(line.replace(ANSI_RE, ""));
  }

  return result.join("\n");
}

// Returns true when the Read tool is reading a non-code file where abstractive
// summarization preserves more value than lossless compression.
function shouldSummarize(toolName: string, toolInput: unknown): boolean {
  if (toolName !== "Read") return false;

  const filePath =
    toolInput !== null && typeof toolInput === "object"
      ? ((toolInput as Record<string, unknown>).file_path as string | undefined)
      : undefined;

  if (!filePath) return false;

  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return true;
  return !CODE_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
}

function applyStructuralFilter(
  commandType: CommandType,
  toolInput: unknown,
  text: string
): string {
  switch (commandType) {
    case "ls": {
      const cmd =
        toolInput !== null && typeof toolInput === "object"
          ? ((toolInput as Record<string, unknown>).command as string | undefined) ?? ""
          : "";
      return filterLsOutput(text, /-[a-zA-Z]*a\b|--all\b/.test(cmd));
    }
    case "grep":
      return filterGrepOutput(text);
    case "git-diff":
      return compactGitDiff(text);
    case "git-log":
      return filterGitLog(text);
    case "git-status":
      return filterGitStatus(text);
    default:
      return text;
  }
}

export interface PostToolResult {
  /** Replacement tool output, or null to leave the original untouched. */
  updatedToolOutput: unknown | null;
  /** Estimated tokens removed from the tool output. */
  saved: number;
  /** Scaledown API calls made. */
  requests: number;
}

type PostToolClient = Pick<ScaledownClient, "compress" | "summarize">;

const UNCHANGED: PostToolResult = { updatedToolOutput: null, saved: 0, requests: 0 };

// Decides what (if anything) replaces a tool's output. Pure apart from the
// Scaledown calls and stderr logging: stats are booked by the caller only
// after the replacement has actually been emitted.
export async function processToolResponse(
  input: HookInput,
  config: Pick<Config, "postToolDisable" | "postToolThreshold" | "postToolLocalOnly" | "compressRate">,
  client: PostToolClient
): Promise<PostToolResult> {
  const { tool_name, tool_input, tool_response } = input;
  if (tool_response === undefined || config.postToolDisable) return UNCHANGED;

  const text = extractText(tool_response);
  if (text === null) return UNCHANGED;

  const toolName = tool_name ?? "generic";
  const commandType = detectCommandType(toolName, tool_input);

  // Structural filter first: zero latency, no API call.
  const filtered = applyStructuralFilter(commandType, tool_input, text);
  const structuralSaving = Math.max(0, estimateTokens(text) - estimateTokens(filtered));
  if (structuralSaving > 0) {
    process.stderr.write(
      `dietcode: structural filter (${commandType}) saved ${structuralSaving} tokens\n`
    );
  }
  const filteredResult: PostToolResult =
    filtered !== text
      ? { updatedToolOutput: replaceText(tool_response, filtered), saved: structuralSaving, requests: 0 }
      : UNCHANGED;

  if (config.postToolLocalOnly || estimateTokens(filtered) < config.postToolThreshold) {
    return filteredResult;
  }

  try {
    if (shouldSummarize(toolName, tool_input)) {
      const result = await client.summarize(filtered);
      const summarizeSaved = estimateTokens(filtered) - estimateTokens(result.summary);
      process.stderr.write(
        `dietcode: summarized Read output (${result.input_chars} → ${result.output_chars} chars, saved ~${filtered.length - result.output_chars})\n`
      );
      return {
        updatedToolOutput: replaceText(tool_response, result.summary),
        saved: structuralSaving + Math.max(0, summarizeSaved),
        requests: 1,
      };
    }
    // The compress endpoint rejects an empty prompt (HTTP 200 + error body),
    // so pass a non-empty instruction alongside the tool output as context.
    const result = await client.compress(
      filtered,
      "Preserve this tool output.",
      config.compressRate
    );
    const origTokens = result.original_prompt_tokens ?? estimateTokens(filtered);
    const compTokens = result.compressed_prompt_tokens ?? (result.compressed_prompt ? estimateTokens(result.compressed_prompt) : 0);
    const saved = origTokens - compTokens;
    process.stderr.write(
      `dietcode: compressed tool output (${origTokens} → ${compTokens} tokens, saved ${saved})\n`
    );
    return {
      updatedToolOutput: replaceText(tool_response, result.compressed_prompt),
      saved: structuralSaving + Math.max(0, saved),
      requests: 1,
    };
  } catch (err) {
    process.stderr.write(
      `dietcode: post-tool compression failed, using filtered output: ${String(err)}\n`
    );
    // Fail open: emit structurally filtered output even when API fails.
    return filteredResult;
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: HookInput = JSON.parse(raw || "{}");
  const sessionId = input.session_id ?? "unknown";

  let config;
  try {
    config = loadConfig();
  } catch {
    process.stdout.write("{}");
    return;
  }

  const result = await processToolResponse(input, config, new ScaledownClient(config.apiKey));
  if (result.updatedToolOutput === null) {
    process.stdout.write("{}");
    return;
  }
  process.stdout.write(JSON.stringify(postToolUseOutput(result.updatedToolOutput)));
  addSaving(sessionId, result.saved);
  for (let i = 0; i < result.requests; i++) addRequest();
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    if (!process.stdin.isTTY) {
      process.stdin.resume();
    } else {
      resolve("{}");
    }
  });
}

main().catch((err) => {
  process.stderr.write(`dietcode post-tool hook error: ${String(err)}\n`);
  process.stdout.write("{}");
});
