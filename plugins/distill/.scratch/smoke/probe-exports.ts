// Smoke probe: does the host's own namespace (`pi.pi`) expose the surfaces the plugin
// needs but whose package subpaths cannot be imported from an extension?
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as sdk from "@oh-my-pi/pi-coding-agent";

const NAMES = [
  "sanitizeSkillName",
  "isValidManagedSkillName",
  "sanitizeManagedDescription",
  "toSkillFrontmatter",
  "MAX_MANAGED_SKILL_BYTES",
  "getManagedSkillsDir",
  "writeManagedSkill",
  "CLI_THINKING_LEVELS",
  "parseCliThinkingLevel",
  "parseConfiguredThinkingLevel",
  "THINKING_EFFORTS",
  "acquireFileLock",
  "withFileLock",
];

const matching = (surface: Record<string, unknown>, pattern: RegExp): string =>
  Object.keys(surface)
    .filter(key => pattern.test(key))
    .slice(0, 12)
    .join(", ");

export default function probe(pi: ExtensionAPI): void {
  pi.registerCommand("probe", {
    description: "probe",
    handler: async () => {
      const host = pi.pi as Record<string, unknown>;
      for (const name of NAMES) {
        process.stdout.write(`${host[name] === undefined ? "missing" : "PRESENT"} pi.pi.${name}\n`);
      }
      process.stdout.write(`pi.pi keys: ${Object.keys(host).length}\n`);
      process.stdout.write(`pi.pi skill-ish: ${matching(host, /skill/i)}\n`);
      process.stdout.write(`pi.pi think-ish: ${matching(host, /think/i)}\n`);
      process.stdout.write(`sdk skill-ish: ${matching(sdk as Record<string, unknown>, /skill/i)}\n`);
      process.stdout.write(`sdk think-ish: ${matching(sdk as Record<string, unknown>, /think/i)}\n`);
      process.stdout.write(`pi.pi === sdk: ${(host as unknown) === (sdk as unknown)}\n`);
    },
  });
}
