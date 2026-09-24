import { describe, expect, test } from "bun:test";
import {
  isValidManagedSkillName,
  MAX_MANAGED_SKILL_BYTES,
  sanitizeManagedDescription,
  sanitizeSkillName,
  toSkillFrontmatter,
} from "../src/skill-rules";

describe("skill rules mirrored from the host", () => {
  test("a name is lowercased and trimmed, and anything that cannot be a directory is refused", () => {
    expect(sanitizeSkillName("  Retry-Backoff ")).toBe("retry-backoff");
    for (const bad of ["", "..", "a/b", "-leading", "with space", "x".repeat(65)]) {
      expect(() => sanitizeSkillName(bad)).toThrow(/Invalid skill name/);
    }
    expect(isValidManagedSkillName("retry-backoff")).toBe(true);
    expect(isValidManagedSkillName("Retry-Backoff")).toBe(false);
  });

  test("a description is flattened to one line, without the characters that could break the skill listing", () => {
    expect(sanitizeManagedDescription("Retries\tare  <b>```\ncoarse~~~")).toBe("Retries are b coarse~");
    expect(sanitizeManagedDescription("\u0000\u200b")).toBe("");
  });

  test("frontmatter carries name and description, and the size cap is the loader's", () => {
    expect(toSkillFrontmatter("retry-backoff", "Retry backoff is coarse")).toBe(
      "---\nname: retry-backoff\ndescription: Retry backoff is coarse\n---\n",
    );
    expect(MAX_MANAGED_SKILL_BYTES).toBe(64_000);
  });
});
