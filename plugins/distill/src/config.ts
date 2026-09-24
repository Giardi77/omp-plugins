import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { fileExists, isRecord, messageOf } from "./util";

/**
 * A project is active only once `.omp/distill/config.yaml` exists (ADR-0004): the plugin
 * installs globally and loads in every session, so the file — not the install — is the
 * activation predicate. Everything distill writes is project-local, and `tmp/` is
 * gitignored by setup so a failure dump can never be committed (ADR-0002).
 */

export interface DistillConfig {
  enabled: boolean;
  model?: string;
  thinking?: string;
  include_thinking: boolean;
  timeout_seconds: number;
  scan_limit: number;
}

export const DEFAULT_CONFIG: DistillConfig = {
  enabled: true,
  include_thinking: false,
  timeout_seconds: 600,
  scan_limit: 5,
};

export interface DistillPaths {
  projectRoot: string;
  root: string;
  configPath: string;
  evaluatorPath: string;
  lessonsDir: string;
  decisionsPath: string;
  tmpDir: string;
  /** Advisory lock anchors; gitignored, and never deleted by purge while a lock is held. */
  locksDir: string;
  gitignorePath: string;
}

export function distillPaths(projectRoot: string): DistillPaths {
  const root = path.join(path.resolve(projectRoot), ".omp", "distill");
  return {
    projectRoot: path.resolve(projectRoot),
    root,
    configPath: path.join(root, "config.yaml"),
    evaluatorPath: path.join(root, "evaluator.md"),
    lessonsDir: path.join(root, "lessons"),
    decisionsPath: path.join(root, "decisions.jsonl"),
    tmpDir: path.join(root, "tmp"),
    locksDir: path.join(root, ".locks"),
    gitignorePath: path.join(root, ".gitignore"),
  };
}

/**
 * The directory tree that owns `.omp/`: walk up from the session's cwd to the closest
 * directory holding one, falling back to the closest repository root, then to cwd itself
 * (mirrors setup-skills and telegram, which resolve their project the same way).
 */
export async function resolveProjectRoot(cwd: string): Promise<string> {
  const start = path.resolve(cwd);
  const home = path.resolve(os.homedir());

  for (const marker of [".omp", ".git"]) {
    let dir = start;
    while (true) {
      if (dir !== home && (await isDirectory(path.join(dir, marker)))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir || dir === home) break;
      dir = parent;
    }
  }
  return start;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads the project's config; `undefined` means the project never activated distill. */
export async function readConfig(paths: DistillPaths): Promise<DistillConfig | undefined> {
  const raw = await readRawConfig(paths);
  if (raw === undefined) return undefined;

  const stringOrUndefined = (key: string) => {
    const value = raw[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };

  return {
    enabled: raw.enabled === undefined ? DEFAULT_CONFIG.enabled : raw.enabled === true,
    model: stringOrUndefined("model"),
    thinking: stringOrUndefined("thinking"),
    include_thinking: raw.include_thinking === true,
    timeout_seconds: positiveNumber(raw.timeout_seconds, DEFAULT_CONFIG.timeout_seconds),
    scan_limit: positiveNumber(raw.scan_limit, DEFAULT_CONFIG.scan_limit),
  };
}

export async function isActive(paths: DistillPaths): Promise<boolean> {
  return (await readRawConfig(paths)) !== undefined;
}

/** Writes the config, preserving keys this plugin does not own. */
export async function writeConfig(paths: DistillPaths, config: DistillConfig): Promise<void> {
  const existing = (await readRawConfig(paths)) ?? {};
  const next = { ...existing, ...serializeConfig(config) };
  await fs.mkdir(paths.root, { recursive: true });
  await Bun.write(paths.configPath, YAML.stringify(next, null, 2));
}

export async function setEnabled(paths: DistillPaths, enabled: boolean): Promise<DistillConfig> {
  const config = await readConfig(paths);
  if (!config) throw new Error(`${paths.configPath} does not exist; run /distill setup first.`);
  await writeConfig(paths, { ...config, enabled });
  return { ...config, enabled };
}

export interface SetupResult {
  paths: DistillPaths;
  config: DistillConfig;
  evaluatorCreated: boolean;
}

/**
 * Setup writes the config, a default `evaluator.md`, and the `tmp/` ignore rule. It gates
 * nothing (D18): the first scan covers whatever history the project already has.
 */
export async function setupProject(
  projectRoot: string,
  options: { model?: string; thinking?: string } = {},
): Promise<SetupResult> {
  const paths = distillPaths(projectRoot);
  const existing = await readConfig(paths);
  const config: DistillConfig = {
    ...(existing ?? DEFAULT_CONFIG),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
  };

  await fs.mkdir(paths.lessonsDir, { recursive: true });
  await fs.mkdir(paths.tmpDir, { recursive: true });
  await Bun.write(paths.gitignorePath, "tmp/\n.locks/\n");
  await writeConfig(paths, config);

  let evaluatorCreated = false;
  if (!(await fileExists(paths.evaluatorPath))) {
    await Bun.write(paths.evaluatorPath, DEFAULT_EVALUATOR_PROMPT);
    evaluatorCreated = true;
  }

  return { paths, config, evaluatorCreated };
}

async function readRawConfig(paths: DistillPaths): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await Bun.file(paths.configPath).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse ${paths.configPath}: ${messageOf(error)}`);
  }
  if (parsed === undefined || parsed === null) return {};
  if (!isRecord(parsed)) throw new Error(`${paths.configPath} must contain a YAML object`);
  return parsed;
}

function serializeConfig(config: DistillConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.thinking === undefined ? {} : { thinking: config.thinking }),
    include_thinking: config.include_thinking,
    timeout_seconds: config.timeout_seconds,
    scan_limit: config.scan_limit,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The default evaluator prompt: taste only. Every mechanical instruction — call the tool
 * once, cite qualified record ids, never quote — rides the `propose_lessons` description
 * instead (D15), so this file never goes stale against the loop.
 */
export const DEFAULT_EVALUATOR_PROMPT = `# What this project learns from its sessions

You read one agent session from this project and decide what, if anything, it teaches the
sessions that follow. You are not summarising it. You are looking for the few things a
future agent would have got wrong without having seen this session.

## The bar

Keep a lesson when all three hold:

- **It changes behaviour.** A future agent reading it would act differently, not merely know
  more. "Tests run from the package root, never the repo root" is a lesson. "The agent ran
  the tests" is not.
- **It is durable.** It stays true next month, in other files, for other tasks. Session
  trivia — a file was renamed, a bug was fixed, a branch was merged — is not.
- **It is not already known.** Read the project's skills and agent prompts first. If one
  already says it, even in different words, there is no lesson.

## What earns a lesson

- A correction the operator made, and the rule that follows from it.
- A path discovered the hard way: an ordering, a flag, a command, a workaround.
- A mistake worth never repeating: a wrong assumption, a refuted approach, a trap.
- Guidance a subagent needed and did not get.

## What does not

- Anything a skill, an agent prompt, or a file you can read already covers.
- One-off facts about a particular bug, file, or ticket.
- Restatements of what the agent did, however well written.
- Preferences this project has not stated.
- A handful of lessons at most. Most sessions teach one thing, or nothing. Proposing
  nothing is a normal, useful answer.

## Worked examples

Bad: "The agent had trouble with the flaky retry test and eventually raised the sleep to
250ms." — a narrative of the session, true but not reusable.

Good: "Retry backoff in this repo is deliberately coarse: sleep at least 250ms between
attempts, because CI load makes 100ms flap. Do not 'optimise' it back down." — a rule with
a reason a future agent can act on.

Bad: "Consider being more careful when editing shared code." — no behaviour changes.

Good: "Anything under packages/core is consumed by the three plugins in this repo in the
same commit; run \`bun run check\` at the repo root before touching it." — specific,
checkable, durable.

Bad: "The operator prefers tabs." — a style preference the project has not stated anywhere
else.

## What you see

You are handed the session's traces: the parent session and its subagents, each record
carrying the id citations must name. You have read, glob and grep with this project as your
working directory, so its skills, its agent prompts and its source are yours to check. The
judgement itself goes through one tool call, whose description states the mechanics.
`;
