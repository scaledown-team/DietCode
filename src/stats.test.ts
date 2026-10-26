import { jest } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import * as os from "os";
import { resolve } from "path";

// STATS_FILE resolves os.homedir() at import time; point it at a temp dir.
const home = mkdtempSync(resolve(os.tmpdir(), "dietcode-stats-"));
jest.unstable_mockModule("os", () => ({ ...os, homedir: () => home }));
const { addSaving, STATS_FILE } = await import("./stats.js");

afterAll(() => rmSync(home, { recursive: true, force: true }));

const read = () => JSON.parse(readFileSync(STATS_FILE, "utf8"));

describe("addSaving", () => {
  it("keeps the estimated token total and the signed net-dollar estimate separately", () => {
    expect(STATS_FILE.startsWith(home)).toBe(true);
    addSaving("s1", 1000, 0.0003);
    addSaving("s1", 0, -0.0005); // a fold that cost more than it saved
    const stats = read();
    expect(stats.totalSaved).toBe(1000);
    expect(stats.sessions.s1).toBe(1000);
    expect(stats.estimatedNetUsd).toBeCloseTo(-0.0002, 10);
  });

  it("ignores non-finite or empty contributions", () => {
    const before = read();
    addSaving("s2", NaN, NaN);
    addSaving("s2", -5);
    expect(read()).toEqual(before);
  });
});
