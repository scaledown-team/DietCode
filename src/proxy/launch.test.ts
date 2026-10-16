import { withAutocompactSettings } from "./launch.js";

describe("withAutocompactSettings", () => {
  it("prepends --settings that raises Claude's auto-compact threshold", () => {
    const out = withAutocompactSettings(["--resume", "abc"]);
    expect(out[0]).toBe("--settings");
    expect(JSON.parse(out[1])).toEqual({ env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "95" } });
    expect(out.slice(2)).toEqual(["--resume", "abc"]);
  });

  it("leaves the user's own --settings alone", () => {
    expect(withAutocompactSettings(["--settings", "my.json"])).toEqual(["--settings", "my.json"]);
    expect(withAutocompactSettings(["--settings={}"])).toEqual(["--settings={}"]);
  });
});
