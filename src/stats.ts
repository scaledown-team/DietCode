import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

interface StatsFile {
  /** Estimated input tokens removed from requests (character-based estimate, not billed usage). */
  totalSaved: number;
  /** Running estimate of net dollars saved by proxy compaction, including
   * folds that cost more than they saved (negative contributions). */
  estimatedNetUsd?: number;
  totalRequests: number;
  sessions: Record<string, number>;
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

// `tokens` is an estimated input-token reduction (only positive values count);
// `netUsd`, when given, is the estimated net dollar effect and is accumulated
// with its sign so unfavourable folds offset favourable ones.
export function addSaving(sessionId: string, tokens: number, netUsd?: number): void {
  const hasTokens = isFinite(tokens) && tokens > 0;
  const hasUsd = netUsd !== undefined && isFinite(netUsd) && netUsd !== 0;
  if (!hasTokens && !hasUsd) return;
  const stats = readStats();
  if (hasTokens) {
    stats.totalSaved = (stats.totalSaved ?? 0) + tokens;
    stats.sessions[sessionId] = (stats.sessions[sessionId] ?? 0) + tokens;
  }
  if (hasUsd) stats.estimatedNetUsd = (stats.estimatedNetUsd ?? 0) + netUsd;
  writeStats(stats);
}

export function setContextWindow(current_tokens: number, max_tokens: number): void {
  const stats = readStats();
  stats.contextWindow = { current_tokens, max_tokens };
  writeStats(stats);
}

export function addRequest(): void {
  const stats = readStats();
  stats.totalRequests = (stats.totalRequests ?? 0) + 1;
  writeStats(stats);
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}
