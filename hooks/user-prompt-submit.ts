#!/usr/bin/env node
import { readFileSync } from "fs";
import { ScaledownClient, type ClassifyResponse } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { addRequest, setContextWindow } from "../src/stats.js";

interface ContextWindow {
  current_tokens: number;
  max_tokens: number;
}

interface HookInput {
  prompt?: string;
  context_window?: ContextWindow;
  session_id?: string;
  transcript_path?: string;
  [key: string]: unknown;
}

function renderProgressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${bar}] ${pct}%`;
}

function logContextProgress(contextWindow: ContextWindow, compactThreshold: number): void {
  const { current_tokens, max_tokens } = contextWindow;
  if (max_tokens === 0) return;
  const pct = Math.round((current_tokens / max_tokens) * 100);
  const bar = renderProgressBar(pct);
  const tokenStr = `${current_tokens.toLocaleString("en-US")} / ${max_tokens.toLocaleString("en-US")} tokens`;
  const suffix = pct >= compactThreshold ? " ⚡ compaction imminent" : "";
  process.stderr.write(`dietcode: ${bar}  ${tokenStr}${suffix}\n`);
}

const INTENT_LABELS = [
  {
    name: "file_read",
    rubric:
      "Does this prompt ask to read, view, or retrieve the contents of a file?",
  },
  {
    name: "file_write",
    rubric: "Does this prompt ask to create, edit, or modify a file?",
  },
  {
    name: "shell_exec",
    rubric:
      "Does this prompt ask to run a shell command, script, or terminal process?",
  },
  {
    name: "search",
    rubric:
      "Does this prompt ask to search for, grep, or find content in files or directories?",
  },
  {
    name: "web",
    rubric:
      "Does this prompt ask to fetch content from a URL or browse the web?",
  },
  {
    name: "general",
    rubric:
      "Is this a conversational message or general question not requiring a specific tool?",
  },
];

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: HookInput = JSON.parse(raw || "{}");
  const prompt = input.prompt;

  if (!prompt) {
    process.stdout.write("{}");
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch {
    // No API key configured — pass through silently
    process.stdout.write("{}");
    return;
  }

  // Read real token counts from the transcript — last assistant usage entry
  // is the most recent actual API usage before this prompt.
  const transcriptPath = input.transcript_path as string | undefined;
  if (transcriptPath) {
    try {
      const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
      type UsageEntry = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
      let lastUsage: UsageEntry | null = null;
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "assistant" && entry.message && typeof entry.message === "object") {
          const usage = (entry.message as Record<string, unknown>).usage as UsageEntry | undefined;
          if (usage) lastUsage = usage;
        }
      }
      if (lastUsage) {
        const current = lastUsage.input_tokens + lastUsage.cache_read_input_tokens + lastUsage.cache_creation_input_tokens;
        const max = config.maxContextTokens;
        setContextWindow(current, max);
        if (config.showProgress) logContextProgress({ current_tokens: current, max_tokens: max }, config.compactThreshold);
      }
    } catch {
      // Transcript unreadable — skip progress display
    }
  }

  if (config.classifyDisable) {
    process.stdout.write("{}");
    return;
  }

  // Intent classification — fail-open. UserPromptSubmit cannot replace or
  // shrink the submitted prompt; the only supported output is extra context
  // (hookSpecificOutput.additionalContext), so the hint is all we emit.
  const client = new ScaledownClient(config.apiKey);
  try {
    const classification = await client.classify(prompt, INTENT_LABELS);
    const hint = intentHint(classification);
    process.stderr.write(`dietcode: ${hint.slice(1, -1)}\n`);
    process.stdout.write(JSON.stringify(userPromptSubmitOutput(hint)));
    addRequest();
  } catch (err) {
    process.stderr.write(
      `dietcode: classify failed, skipping hint: ${String(err)}\n`
    );
    process.stdout.write("{}");
  }
}

export function intentHint(classification: ClassifyResponse): string {
  const topScore = classification.scores[classification.top_label] ?? 0;
  return `[DietCode intent: ${classification.top_label} (${Math.round(topScore * 100)}%)]`;
}

// Builds the hook's stdout per the Claude Code UserPromptSubmit contract.
export function userPromptSubmitOutput(additionalContext: string): {
  hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string };
} {
  return {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // Resolve immediately if stdin is not a pipe (e.g. in tests)
    if (!process.stdin.isTTY) {
      process.stdin.resume();
    } else {
      resolve("{}");
    }
  });
}

main().catch((err) => {
  process.stderr.write(`dietcode hook error: ${String(err)}\n`);
  process.stdout.write("{}");
});
