import { describe, expect, test } from "bun:test";
import { CLI_THINKING_LEVELS, parseCliThinkingLevel } from "../src/thinking";

describe("thinking selectors mirrored from the host", () => {
  test("every offered level parses to itself", () => {
    expect([...CLI_THINKING_LEVELS]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
    for (const level of CLI_THINKING_LEVELS) {
      expect(parseCliThinkingLevel(level)).toBe(level);
    }
  });

  test("an unambiguous abbreviation parses, and everything else is a refusal rather than a default", () => {
    expect(parseCliThinkingLevel("xhi")).toBe("xhigh");
    expect(parseCliThinkingLevel("min")).toBe("minimal");
    expect(parseCliThinkingLevel("au")).toBe("auto");
    expect(parseCliThinkingLevel("h")).toBeUndefined();
    expect(parseCliThinkingLevel("inherit")).toBeUndefined();
    expect(parseCliThinkingLevel("")).toBeUndefined();
    expect(parseCliThinkingLevel(undefined)).toBeUndefined();
  });
});
