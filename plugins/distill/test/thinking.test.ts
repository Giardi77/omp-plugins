import { describe, expect, test } from "bun:test";
import { CLI_THINKING_LEVELS, parseCliThinkingLevel, supportedThinkingLevels } from "../src/thinking";

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

describe("the levels a model can actually honor", () => {
  test("a reasoning model offers off, its own ladder, then auto", () => {
    expect(supportedThinkingLevels({ reasoning: true, thinking: { efforts: ["low", "high", "max"] } })).toEqual([
      "off",
      "low",
      "high",
      "max",
      "auto",
    ]);
    expect(supportedThinkingLevels({ reasoning: true, thinking: { efforts: ["high", "xhigh"] } })).toEqual([
      "off",
      "high",
      "xhigh",
      "auto",
    ]);
  });

  test("a model with no effort surface is left with its two real choices", () => {
    expect(supportedThinkingLevels({ reasoning: true })).toEqual(["off", "auto"]);
    expect(supportedThinkingLevels({ reasoning: true, thinking: {} })).toEqual(["off", "auto"]);
    // An `efforts` list on a non-reasoning entry is catalog noise: the host's own reading gates on
    // `reasoning` first, so this does too rather than offering levels the model cannot honor.
    expect(supportedThinkingLevels({ reasoning: false, thinking: { efforts: ["low", "high"] } })).toEqual([
      "off",
      "auto",
    ]);
  });

  test("an unresolvable model falls back to the whole vocabulary rather than to nothing", () => {
    expect(supportedThinkingLevels(undefined)).toEqual(CLI_THINKING_LEVELS);
  });

  test("every level the picker can offer is one the CLI accepts", () => {
    // The picker writes what it offers into config.yaml, and setup validates against the CLI
    // vocabulary: a level outside it would produce a config the operator cannot re-run setup over.
    const models = [
      { reasoning: true, thinking: { efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] } },
      { reasoning: true, thinking: { efforts: ["high"] } },
      { reasoning: false },
      undefined,
    ];
    for (const model of models) {
      const offered = supportedThinkingLevels(model);
      expect(offered.length).toBeGreaterThan(0);
      for (const level of offered) expect(parseCliThinkingLevel(level)).toBe(level);
    }
  });
});
