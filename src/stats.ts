import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

interface StatsFile {
  totalSaved: number;
  totalRequests: number;
  sessions: Record<string, number>;
  sessionRequests?: Record<string, number>;
  contextWindow?: { current_tokens: number; max_tokens: number };
}

export const STATS_FILE = resolve(homedir(), ".scaledown", "stats.json");

function readStats(): StatsFile {
  try {
    return JSON.parse(readFileSync(STATS_FILE, "utf8")) as StatsFile;
  } catch {
    return { totalSaved: 0, totalRequests: 0, sessions: {} };
  }
}

function writeStats(stats: StatsFile): void {
  const dir = resolve(STATS_FILE, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2) + "\n", "utf8");
}

export function addSaving(sessionId: string, tokens: number): void {
  if (!isFinite(tokens) || tokens <= 0) return;
  const stats = readStats();
  stats.totalSaved = (stats.totalSaved ?? 0) + tokens;
  stats.sessions[sessionId] = (stats.sessions[sessionId] ?? 0) + tokens;
  writeStats(stats);
}

export function setContextWindow(current_tokens: number, max_tokens: number): void {
  const stats = readStats();
  stats.contextWindow = { current_tokens, max_tokens };
  writeStats(stats);
}

export function addRequest(sessionId?: string): void {
  const stats = readStats();
  stats.totalRequests = (stats.totalRequests ?? 0) + 1;
  if (sessionId) {
    stats.sessionRequests ??= {};
    stats.sessionRequests[sessionId] = (stats.sessionRequests[sessionId] ?? 0) + 1;
  }
  writeStats(stats);
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}
