import type { ClassifyResponse } from "../src/client.js";
import { intentHint, userPromptSubmitOutput } from "./user-prompt-submit.js";

const CLASSIFY_RESPONSE: ClassifyResponse = {
  top_label: "file_read",
  scores: { file_read: 0.87, general: 0.13 },
  labels: [
    { label: "file_read", score: 0.87, rubric: "Does this prompt ask to read a file?" },
    { label: "general", score: 0.13, rubric: "Is this a general question?" },
  ],
};

describe("intentHint", () => {
  it("formats the top label and its score", () => {
    expect(intentHint(CLASSIFY_RESPONSE)).toBe("[DietCode intent: file_read (87%)]");
  });
});

describe("userPromptSubmitOutput", () => {
  it("emits the hint as additionalContext, never as a replacement prompt", () => {
    const out = userPromptSubmitOutput("[DietCode intent: search (82%)]");
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "[DietCode intent: search (82%)]",
      },
    });
    expect(out).not.toHaveProperty("prompt");
  });
});
