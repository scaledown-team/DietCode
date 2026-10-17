import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

// Exercise the built status command, including its top-level error handler.
// A fresh cache prevents update checks and automatic reconciliation.
let testHome: string;
beforeEach(() => {
  testHome = mkdtempSync(resolve(tmpdir(), "dietcode-status-"));
  mkdirSync(resolve(testHome, ".scaledown"));
  writeFileSync(resolve(testHome, ".scaledown/config.json"), JSON.stringify({
    _updateCache: {
      lastChecked: new Date().toISOString(),
      lastReconciled: new Date().toISOString(),
      latestVersion: JSON.parse(readFileSync(resolve("package.json"), "utf8")).version,
      updateTriggered: false,
    },
  }));
});
afterEach(() => rmSync(testHome, { recursive: true, force: true }));

function status(contextWindow?: unknown): string {
  writeFileSync(resolve(testHome, ".scaledown/stats.json"), JSON.stringify({
    totalSaved: 1200,
    totalRequests: 7,
    sessions: {},
    contextWindow,
  }));
  return execFileSync(process.execPath, [resolve("dist/hooks/status.js")], {
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, HOME: testHome, DIETCODE_PROXY: "1" },
    timeout: 5000,
  });
}

it.each([
  [0, "░░░░░░░░░░"],
  [50, "█████░░░░░"],
  [100, "██████████"],
  [110, "██████████"],
  [250, "██████████"],
])("renders %s%% context without losing the rest of the status line", (pct, bar) => {
  expect(status({ current_tokens: pct * 2000, max_tokens: 200000 }))
    .toBe(`[${bar}] ${pct}% ctx  ·  ↓ 1.2K saved  ·  7 reqs`);
});

it.each([
  undefined,
  { current_tokens: -20000, max_tokens: 200000 },
  { current_tokens: 1000, max_tokens: 0 },
  { current_tokens: 1000, max_tokens: -1 },
  { current_tokens: null, max_tokens: 200000 },
  { current_tokens: "1000", max_tokens: 200000 },
  { current_tokens: 1000, max_tokens: "200000" },
  { max_tokens: 200000 },
  { current_tokens: 1e308, max_tokens: 1e-308 },
])("omits invalid context data (%j) while preserving savings", (contextWindow) => {
  expect(status(contextWindow)).toBe("↓ 1.2K saved  ·  7 reqs");
});
