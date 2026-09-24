import { YAML } from "bun";

/**
 * The managed-skill rules distill writes against, mirrored from the host's
 * `@oh-my-pi/pi-coding-agent/autolearn/managed-skills` (omp 18.3.0).
 *
 * A compiled omp host serves host *package roots* to extensions but not that subpath: importing
 * it fails the whole extension load (`Cannot find package '@oh-my-pi/pi-natives'` from the host's
 * own on-disk pi-utils copy), and `/distill` then never registers. The rules matter enough to keep
 * — a name the loader rejects throws, a description that sanitizes to empty is dropped by skill
 * discovery, and a body over the cap is refused — so the behaviour is mirrored here with the
 * host's exact names, messages and limits. `test/skill-rules.test.ts` pins it; ADR-0011 records
 * why, and when the host exposes the module again this file goes away.
 */

/** Hard cap on a SKILL.md body. Mirrors the host's `MAX_MANAGED_SKILL_BYTES`. */
export const MAX_MANAGED_SKILL_BYTES = 64_000;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate + normalize a skill name: lowercase, digits and hyphens, 1-64 chars. Throws otherwise. */
export function sanitizeSkillName(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid skill name "${raw}". Use lowercase letters, digits, and hyphens (1-64 chars, starting with a letter or digit).`,
    );
  }
  return name;
}

/** Whether `name` is the exact post-sanitize shape, without normalizing it first. */
export function isValidManagedSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

/**
 * One line, no control or format characters, no angle brackets, backticks or fence runs: the
 * description is rendered inside the system prompt's `<skills>` listing, so this is a trust
 * boundary and runs on both write and read.
 */
export function sanitizeManagedDescription(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[<>`]/g, "")
    .replace(/~{2,}/g, "~")
    .replace(/\s+/g, " ")
    .trim();
}

/** The minimal `name`/`description` frontmatter block, round-tripping through `parseFrontmatter`. */
export function toSkillFrontmatter(name: string, description: string): string {
  const frontmatter = YAML.stringify({ name, description: sanitizeManagedDescription(description) }, null, 2).trimEnd();
  return `---\n${frontmatter}\n---\n`;
}
