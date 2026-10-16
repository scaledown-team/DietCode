// Local persistence for the DietCode proxy.
//
// Two stores, both under ~/.scaledown:
//   proxy/<sessionId>.json  — per-conversation progressive-compaction state
//                             (the running summary + how far we've compacted).
//   proxy-cache/<hash>.json — original content stashed when a block is replaced,
//                             so the `sd_retrieve` MCP tool can pull it back.
//
// Style mirrors src/stats.ts: synchronous fs, fail-soft, JSON files.

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { resolve } from "path";

// Resolved lazily (not at module load) so paths reflect $HOME at call time —
// important for tests that sandbox HOME, harmless in production.
export const sessionDir = (): string => resolve(homedir(), ".scaledown", "proxy");
export const cacheDir = (): string => resolve(homedir(), ".scaledown", "proxy-cache");

/** Progressive-compaction state for one conversation. */
export interface SessionState {
  /** The running ScaleDown summary standing in for all aged-out turns. */
  runningSummary: string;
  /** Count of leading messages already folded into runningSummary. */
  agedThrough: number;
  /** sd_retrieve id of the full transcript behind runningSummary (set at each fold). */
  retrieveId?: string;
  /** Fingerprint of messages[0, agedThrough) at the last fold, to detect a
   * different conversation that maps to the same session key. */
  prefixHash?: string;
  updatedAt: string;
}

const EMPTY_STATE: SessionState = {
  runningSummary: "",
  agedThrough: 0,
  updatedAt: "",
};

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Filesystem-safe id (session ids are uuids, but never trust input on a path).
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "default";
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-session compaction state
// ---------------------------------------------------------------------------

export function loadSessionState(sessionId: string): SessionState {
  try {
    const path = resolve(sessionDir(), `${safeId(sessionId)}.json`);
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionState>;
      return {
        runningSummary: parsed.runningSummary ?? "",
        agedThrough: parsed.agedThrough ?? 0,
        ...(parsed.retrieveId && { retrieveId: parsed.retrieveId }),
        ...(parsed.prefixHash && { prefixHash: parsed.prefixHash }),
        updatedAt: parsed.updatedAt ?? "",
      };
    }
  } catch {
    // Missing or malformed — start fresh.
  }
  return { ...EMPTY_STATE };
}

export function saveSessionState(sessionId: string, state: SessionState): void {
  try {
    ensureDir(sessionDir());
    const path = resolve(sessionDir(), `${safeId(sessionId)}.json`);
    writeFileSync(
      path,
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n",
      "utf8"
    );
  } catch {
    // Persistence is best-effort; a write failure must never break a request.
  }
}

// ---------------------------------------------------------------------------
// Content cache (reversibility for the optional per-block compressor)
// ---------------------------------------------------------------------------

export interface CachedBlock {
  original: string;
  compressed: string;
}

/** Returns the deterministic id for a piece of original content. */
export function putOriginal(original: string, compressed: string): string {
  const id = shortHash(original);
  try {
    ensureDir(cacheDir());
    const path = resolve(cacheDir(), `${id}.json`);
    if (!existsSync(path)) {
      writeFileSync(
        path,
        JSON.stringify({ original, compressed } satisfies CachedBlock),
        "utf8"
      );
    }
  } catch {
    // Best-effort.
  }
  return id;
}

export function getOriginal(id: string): string | null {
  try {
    const path = resolve(cacheDir(), `${safeId(id)}.json`);
    if (existsSync(path)) {
      return (JSON.parse(readFileSync(path, "utf8")) as CachedBlock).original;
    }
  } catch {
    // ignore
  }
  return null;
}

export function getCached(id: string): CachedBlock | null {
  try {
    const path = resolve(cacheDir(), `${safeId(id)}.json`);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as CachedBlock;
    }
  } catch {
    // ignore
  }
  return null;
}
