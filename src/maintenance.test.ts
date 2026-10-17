import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version as string;
const [major, minor, patch] = version.split(".").map(Number);
const latest = `${major}.${minor}.${patch + 1}`;

// Run built entry points in fresh processes so module-level paths use an
// isolated home. Stub both external side effects before importing the code.
const stubs = `
  import childProcess from "node:child_process";
  import { syncBuiltinESMExports } from "node:module";
  childProcess.spawn = (...args) => {
    console.log("SPAWN " + JSON.stringify(args));
    return { unref() {} };
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => {
    console.log("FETCH");
    return new Response(JSON.stringify({ version: "${latest}" }));
  };
`;
let testHome: string;
let settingsPath: string;
let configPath: string;
const settings = JSON.stringify({
  custom: "preserve me",
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "old/dietcode-hook" }] }] },
});

beforeEach(() => {
  testHome = mkdtempSync(resolve(tmpdir(), "dietcode-maintenance-"));
  settingsPath = resolve(testHome, ".claude/settings.json");
  configPath = resolve(testHome, ".scaledown/config.json");
  mkdirSync(resolve(testHome, ".claude"));
  mkdirSync(resolve(testHome, ".scaledown"));
  writeFileSync(settingsPath, settings);
});
afterEach(() => rmSync(testHome, { recursive: true, force: true }));

function run(code: string, overrides: NodeJS.ProcessEnv = {}): string {
  const env = { ...process.env, HOME: testHome, DIETCODE_PROXY: "1" };
  for (const key of ["SCALEDOWN_UPDATE_CHECK", "SCALEDOWN_AUTO_UPDATE", "SCALEDOWN_AUTO_RECONCILE", "npm_lifecycle_event"]) {
    delete (env as NodeJS.ProcessEnv)[key];
  }
  return execFileSync(process.execPath, ["--input-type=module", "-e", stubs + code], {
    env: { ...env, ...overrides }, input: "{}", encoding: "utf8", timeout: 5000,
  });
}

function cache(updateTriggered = false): void {
  writeFileSync(configPath, JSON.stringify({ apiKey: "fixture-key", _updateCache: {
    latestVersion: latest, lastChecked: new Date().toISOString(), updateTriggered,
  } }));
}

it("disables registry access and cache writes when checks are off", () => {
  expect(run(`const u = await import('./dist/src/update.js'); console.log(await u.checkForUpdate());`, {
    SCALEDOWN_UPDATE_CHECK: "false",
  }).trim()).toBe("null");
  expect(existsSync(configPath)).toBe(false);
});

it("suppresses cached notifications when checks are off", () => {
  cache(true);
  const before = readFileSync(configPath, "utf8");
  const output = run(`await import('./dist/hooks/status.js');`, {
    SCALEDOWN_UPDATE_CHECK: "false", SCALEDOWN_AUTO_RECONCILE: "false",
  });
  expect(output).toBe("↓ 0 saved");
  expect(readFileSync(configPath, "utf8")).toBe(before);
  expect(readFileSync(settingsPath, "utf8")).toBe(settings);
});

it("checks for updates and notifies without installing by default", () => {
  const output = run(`await import('./dist/hooks/status.js');`, { SCALEDOWN_AUTO_RECONCILE: "false" });
  expect(output).toContain("FETCH");
  expect(output).toContain(`v${latest} available: npm i -g dietcode@latest`);
  expect(output).not.toContain("SPAWN");
  expect(JSON.parse(readFileSync(configPath, "utf8"))._updateCache.updateTriggered).toBe(false);
  expect(readFileSync(settingsPath, "utf8")).toBe(settings);
});

it.each([undefined, "false"])("guards direct background installation when auto-update is %s", (value) => {
  const output = run(`const u = await import('./dist/src/update.js'); console.log(u.triggerBackgroundUpdate());`, {
    SCALEDOWN_AUTO_UPDATE: value,
  });
  expect(output.trim()).toBe("false");
  expect(existsSync(configPath)).toBe(false);
});

it("installs a cached minor update only after explicit opt-in", () => {
  cache();
  const output = run(`await import('./dist/hooks/status.js');`, {
    SCALEDOWN_AUTO_UPDATE: "true", SCALEDOWN_AUTO_RECONCILE: "false",
  });
  expect(output).toContain('SPAWN ["npm",["install","-g","dietcode@latest"]');
  expect(output).toContain(`updating to v${latest}...`);
  expect(output).not.toContain("FETCH");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  expect(config._updateCache.updateTriggered).toBe(true);
  expect(config.apiKey).toBe("fixture-key");
});

it("shows pending installations without starting another", () => {
  cache(true);
  const output = run(`await import('./dist/hooks/status.js');`, {
    SCALEDOWN_AUTO_RECONCILE: "false", SCALEDOWN_AUTO_UPDATE: "true",
  });
  expect(output).toContain(`restart to activate v${latest}`);
  expect(output).not.toContain("SPAWN");
});

it("leaves all files untouched when automatic maintenance is disabled", () => {
  const output = run(`await import('./dist/hooks/status.js');`, {
    SCALEDOWN_AUTO_RECONCILE: "false", SCALEDOWN_UPDATE_CHECK: "false", SCALEDOWN_AUTO_UPDATE: "false",
  });
  expect(output).toBe("↓ 0 saved");
  expect(readFileSync(settingsPath, "utf8")).toBe(settings);
  expect(existsSync(configPath)).toBe(false);
});

it("retains automatic reconciliation by default independently of update checks", () => {
  run(`await import('./dist/hooks/status.js');`, { SCALEDOWN_UPDATE_CHECK: "false" });
  const refreshed = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(refreshed.statusLine.command).toContain("status.js");
  expect(refreshed.custom).toBe("preserve me");
});

it("skips postinstall reconciliation when disabled", () => {
  run(`await import('./dist/bin/postinstall.js');`, {
    npm_lifecycle_event: "postinstall", SCALEDOWN_AUTO_RECONCILE: "false",
  });
  expect(readFileSync(settingsPath, "utf8")).toBe(settings);
  expect(existsSync(configPath)).toBe(false);
});

it("keeps explicit reconciliation available when automatic reconciliation is off", () => {
  run(`await import('./dist/bin/postinstall.js');`, { SCALEDOWN_AUTO_RECONCILE: "false" });
  const refreshed = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(refreshed.statusLine.command).toContain("status.js");
  expect(refreshed.custom).toBe("preserve me");
});

it("retains postinstall reconciliation by default", () => {
  run(`await import('./dist/bin/postinstall.js');`, { npm_lifecycle_event: "postinstall" });
  expect(JSON.parse(readFileSync(settingsPath, "utf8")).statusLine.command).toContain("status.js");
});
