// Smoke probe matrix: which static host-package imports does a real omp process load
// from inside this plugin? One extension file per specifier, each run in its own host
// process; a loaded extension answers `/probe` and exits, a failed one logs the error.
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SPECIFIERS = [
  "@oh-my-pi/pi-utils",
  "@oh-my-pi/pi-utils/file-lock",
  "@oh-my-pi/pi-tui",
  "@oh-my-pi/pi-tui/thinking",
  "@oh-my-pi/pi-tui/chrome",
  "@oh-my-pi/pi-coding-agent",
  "@oh-my-pi/pi-coding-agent/session/session-loader",
  "@oh-my-pi/pi-coding-agent/autolearn/managed-skills",
  "@oh-my-pi/pi-natives",
];

const here = import.meta.dir;
const project = "/tmp/distill-smoke/project";

const slug = (specifier: string): string => specifier.replace(/[/@]/g, "-");
const body = (specifier: string): string => `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as mod from ${JSON.stringify(specifier)};
export default function probe(pi: ExtensionAPI): void {
  pi.registerCommand("probe", {
    description: "probe",
    handler: async () => {
      process.stdout.write("PROBE-OK ${specifier} exports=" + Object.keys(mod).length + "\\n");
    },
  });
}
`;

const files: Array<{ specifier: string; file: string }> = [];
for (const specifier of SPECIFIERS) {
  const file = path.join(here, `probe-${slug(specifier)}.ts`);
  await fs.writeFile(file, body(specifier));
  files.push({ specifier, file });
}

for (const { specifier, file } of files) {
  const proc = Bun.spawnSync({
    cmd: ["omp", "-p", "--no-session", "--max-time", "3", "-e", file, "/probe"],
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const marker = stdout.includes(`PROBE-OK ${specifier}`);
  const failure = stdout.match(/Failed to load extension[^\n]*/)?.[0] ?? "";
  console.log(`${marker ? "OK  " : "FAIL"} ${specifier}${failure ? `\n      ${failure.slice(0, 200)}` : ""}`);
}
