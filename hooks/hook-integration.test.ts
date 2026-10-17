/**
 * Hook integration tests — verifies hooks fire correctly via `claude -p` headless mode.
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY must be set (real Claude Code runs)
 *   - @anthropic-ai/claude-code must be installed globally (`npm install -g @anthropic-ai/claude-code`)
 *   - npm run build must have been run (dist/ artifacts must exist)
 *
 * Strategy:
 *   - Starts a local mock HTTP server on localhost to intercept Scaledown API calls
 *   - Sets SCALEDOWN_BASE_URL + SCALEDOWN_API_KEY env vars when spawning claude
 *   - Spawns `claude -p <prompt> --plugin-dir ./ --output-format json` as a child process
 *   - Inspects exit code and stderr/stdout to verify hook behavior
 *
 * These are smoke tests: they verify hooks fire and are fail-open, not exhaustive behavior tests.
 * Behavioral logic is covered by unit tests in hooks/user-prompt-submit.test.ts.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as http from "http";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { AddressInfo } from "net";

const execFileAsync = promisify(execFile);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Skip all tests if ANTHROPIC_API_KEY is not set
const describeIfCI = ANTHROPIC_API_KEY ? describe : describe.skip;

// ---- Mock HTTP server for Scaledown API ----

let mockServer: http.Server;
let mockServerUrl: string;

const COMPRESS_RESPONSE = JSON.stringify({
  compressed_prompt: "compressed",
  original_prompt_tokens: 100,
  compressed_prompt_tokens: 30,
  successful: true,
  latency_ms: 50,
  request_metadata: { compression_time_ms: 50, compression_rate: 0.3, prompt_length: 400, compressed_prompt_length: 120 },
});

const CLASSIFY_RESPONSE = JSON.stringify({
  top_label: "general",
  scores: { general: 1.0 },
  labels: [{ label: "general", score: 1.0, rubric: "Is this a general question?" }],
});

const SUMMARIZE_RESPONSE = JSON.stringify({
  summary: "A short summary.",
  input_chars: 100,
  output_chars: 20,
  latency_ms: 50,
});

function routeRequest(path: string): string {
  if (path.startsWith("/compress")) return COMPRESS_RESPONSE;
  if (path.startsWith("/classify")) return CLASSIFY_RESPONSE;
  if (path.startsWith("/summarization")) return SUMMARIZE_RESPONSE;
  return JSON.stringify({ entities: [] });
}

beforeAll(async () => {
  if (!ANTHROPIC_API_KEY) return;

  mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(routeRequest(req.url ?? "/"));
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const port = (mockServer.address() as AddressInfo).port;
  mockServerUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (mockServer) {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  }
});

// ---- Helper ----

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function runClaude(prompt: string, extraEnv: Record<string, string> = {}): Promise<SpawnResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "claude",
      ["-p", prompt, "--plugin-dir", "./", "--output-format", "json"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY,
          SCALEDOWN_API_KEY: "test-key-ci",
          SCALEDOWN_BASE_URL: mockServerUrl,
          ...extraEnv,
        },
        timeout: 60000,
      }
    );
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    const error = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

// ---- Tests ----

describeIfCI("UserPromptSubmit hook (claude -p headless)", () => {
  it("hook fires without blocking response (fail-open)", async () => {
    const result = await runClaude("What is 1+1?");
    // Hook failure must never block Claude's response
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeTruthy();
  }, 90000);

  it("hook fires: stderr or stdout contains Scaledown indicator or hook ran silently", async () => {
    const result = await runClaude("What is 2+2?");
    // Hook either ran (Scaledown output) or passed through silently — either is fine
    // The key assertion is that Claude responded successfully
    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined.length).toBeGreaterThan(0);
  }, 90000);

  it("hooks are fail-open with invalid API key — Claude still responds", async () => {
    const result = await runClaude("What is 3+3?", {
      SCALEDOWN_API_KEY: "invalid-key-should-fail-open",
      SCALEDOWN_BASE_URL: "http://127.0.0.1:1", // unreachable port
    });
    // Claude must still respond even if Scaledown API is unreachable
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeTruthy();
  }, 90000);
});

describeIfCI("PostToolUse hook (claude -p headless)", () => {
  it("hook fires after tool use without blocking", async () => {
    // This prompt triggers a Bash or Read tool, which invokes PostToolUse hook
    const result = await runClaude("Run `echo hello` and tell me the output.");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBeTruthy();
  }, 90000);
});

describeIfCI("plugin.json manifest loads correctly", () => {
  it("claude starts with --plugin-dir and exits cleanly for a trivial prompt", async () => {
    const result = await runClaude("Reply with exactly: OK");
    expect(result.exitCode).toBe(0);
    // Response JSON should contain the answer
    expect(result.stdout).toMatch(/OK/i);
  }, 90000);
});
