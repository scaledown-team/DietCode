import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { loadMaintenanceConfig } from "./config.js";
import { reconcileAll } from "./reconcile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// From dist/src/update.js, package.json is at ../../package.json
let CURRENT_VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
  CURRENT_VERSION = pkg.version ?? "0.0.0";
} catch {
  // fallback — non-fatal
}

const CONFIG_FILE = resolve(homedir(), ".scaledown", "config.json");

export type UpdateKind = "none" | "minor" | "major";

export interface UpdateResult {
  current: string;
  latest: string;
  kind: UpdateKind;
  alreadyTriggered: boolean;
}

interface UpdateCache {
  lastChecked: string;
  latestVersion: string;
  updateTriggered: boolean;
  lastReconciled?: string;
}

interface RawConfig {
  _updateCache?: UpdateCache;
  [key: string]: unknown;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function classifyUpdate(current: string, latest: string): UpdateKind {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return "none";
  if (l[0] > c[0]) return "major";
  if (l[0] === c[0] && (l[1] > c[1] || (l[1] === c[1] && l[2] > c[2]))) return "minor";
  return "none";
}

function readRawConfig(): RawConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as RawConfig;
    }
  } catch {
    // malformed — return empty
  }
  return {};
}

function writeRawConfig(raw: RawConfig): void {
  try {
    const dir = resolve(CONFIG_FILE, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2) + "\n", "utf8");
  } catch {
    // non-fatal
  }
}

function readCache(): UpdateCache | null {
  return readRawConfig()._updateCache ?? null;
}

function writeCache(cache: UpdateCache): void {
  const raw = readRawConfig();
  // Merge so independent fields (e.g. lastReconciled vs lastChecked) written by
  // different code paths don't clobber each other.
  raw._updateCache = { ...raw._updateCache, ...cache };
  writeRawConfig(raw);
}

// Self-heals harness config at most once per day. This is the safety net for
// when postinstall was skipped (`npm install --ignore-scripts`) or the global
// install path changed (Node version bump) without a reinstall. Cheap and
// fail-soft — called from the status line, which already runs ~daily logic.
export function reconcileIfStale(): void {
  if (!loadMaintenanceConfig().autoReconcile) return;
  try {
    const cache = readCache();
    if (cache?.lastReconciled) {
      const elapsed = Date.now() - new Date(cache.lastReconciled).getTime();
      if (elapsed < 24 * 60 * 60 * 1000) return;
    }
    reconcileAll();
    writeCache({
      lastChecked: cache?.lastChecked ?? new Date().toISOString(),
      latestVersion: cache?.latestVersion ?? CURRENT_VERSION,
      updateTriggered: cache?.updateTriggered ?? false,
      lastReconciled: new Date().toISOString(),
    });
  } catch {
    // non-fatal — never crash the caller (status line)
  }
}

function needsCheck(cache: UpdateCache | null): boolean {
  if (!cache) return true;
  const elapsed = Date.now() - new Date(cache.lastChecked).getTime();
  return elapsed > 24 * 60 * 60 * 1000;
}

export function triggerBackgroundUpdate(): boolean {
  if (!loadMaintenanceConfig().autoUpdate) return false;
  try {
    const child = spawn("npm", ["install", "-g", "dietcode@latest"], {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    const cache = readCache();
    writeCache({
      lastChecked: cache?.lastChecked ?? new Date().toISOString(),
      latestVersion: cache?.latestVersion ?? CURRENT_VERSION,
      updateTriggered: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function checkForUpdate(): Promise<UpdateResult | null> {
  if (!loadMaintenanceConfig().updateCheck) return null;
  try {
    const cache = readCache();

    // If update was already triggered and is still pending, return cached result
    if (cache?.updateTriggered) {
      const kind = classifyUpdate(CURRENT_VERSION, cache.latestVersion);
      if (kind !== "none") {
        return { current: CURRENT_VERSION, latest: cache.latestVersion, kind, alreadyTriggered: true };
      }
      // Update landed — clear the triggered flag
      writeCache({ ...cache, updateTriggered: false });
    }

    // Use cached latest version if within 24h
    if (!needsCheck(cache) && cache) {
      const kind = classifyUpdate(CURRENT_VERSION, cache.latestVersion);
      return { current: CURRENT_VERSION, latest: cache.latestVersion, kind, alreadyTriggered: false };
    }

    // Fetch from registry with 4s timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    let latestVersion: string;
    try {
      const res = await fetch("https://registry.npmjs.org/dietcode/latest", {
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: string };
      latestVersion = data.version ?? "";
    } finally {
      clearTimeout(timeout);
    }

    if (!latestVersion) return null;

    writeCache({ lastChecked: new Date().toISOString(), latestVersion, updateTriggered: false });

    const kind = classifyUpdate(CURRENT_VERSION, latestVersion);
    return { current: CURRENT_VERSION, latest: latestVersion, kind, alreadyTriggered: false };
  } catch {
    return null;
  }
}
