#!/usr/bin/env node
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { checkForUpdate, triggerBackgroundUpdate, reconcileIfStale } from "../src/update.js";

interface StatsFile {
  totalSaved: number;
  totalRequests: number;
  sessions: Record<string, number>;
  sessionRequests?: Record<string, number>;
}

interface SessionInput {
  session_id?: string;
  // Claude Code's own view of this session's context; used_percentage is null
  // until the first response.
  context_window?: { used_percentage?: number | null };
  [key: string]: unknown;
}

const STATS_FILE = resolve(homedir(), ".scaledown", "stats.json");

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function readStats(): StatsFile {
  try {
    return JSON.parse(readFileSync(STATS_FILE, "utf8")) as StatsFile;
  } catch {
    return { totalSaved: 0, totalRequests: 0, sessions: {} };
  }
}

// True when this Claude Code session is running through DietCode's proxy. The
// `dietcode claude` wrapper sets DIETCODE_PROXY=1 on the child (which the status
// line inherits); we also accept a loopback ANTHROPIC_BASE_URL for the manual
// `dietcode proxy` + export workflow.
function proxyActive(): boolean {
  if (process.env.DIETCODE_PROXY === "1") return true;
  return /127\.0\.0\.1|localhost/.test(process.env.ANTHROPIC_BASE_URL ?? "");
}

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => res(data));
    if (process.stdin.isTTY) res("{}");
    else process.stdin.resume();
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let sessionId = "unknown";
  let usedPct: number | null = null;
  try {
    const input = JSON.parse(raw) as SessionInput;
    if (input.session_id) sessionId = input.session_id;
    const used = input.context_window?.used_percentage;
    if (typeof used === "number" && Number.isFinite(used)) usedPct = used;
  } catch {
    // use unknown
  }

  // Self-heal harness config at most once a day (no-op otherwise).
  reconcileIfStale();

  // This session's numbers only. The proxy and hooks record savings under
  // Claude Code's session id; the context bar is Claude Code's own figure for
  // this session, which in a proxy session reflects the compacted request.
  const stats = readStats();
  const saved = stats.sessions?.[sessionId] ?? 0;
  const requests = stats.sessionRequests?.[sessionId] ?? 0;

  const parts: string[] = [];

  if (usedPct !== null) {
    const pct = Math.min(100, Math.max(0, Math.round(usedPct)));
    const filled = Math.round((pct / 100) * 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    parts.push(`[${bar}] ${pct}% ctx`);
  }

  parts.push(`↓ ${formatTokenCount(saved)} saved`);
  if (requests > 0) parts.push(`${requests} reqs`);

  // Off-proxy nudge: compaction (real token savings) only runs via the proxy.
  if (!proxyActive()) parts.push("compaction off: start with `dietcode claude`");

  try {
    const update = await checkForUpdate();
    if (update && update.kind === "minor") {
      if (!update.alreadyTriggered) {
        triggerBackgroundUpdate();
        parts.push(`updating to v${update.latest}...`);
      } else {
        parts.push(`restart to activate v${update.latest}`);
      }
    } else if (update && update.kind === "major") {
      parts.push(`v${update.latest} available: npm i -g dietcode@latest`);
    }
  } catch {
    // non-fatal — never crash status line
  }

  process.stdout.write(parts.join("  ·  "));
}

main().catch(() => process.stdout.write(""));
