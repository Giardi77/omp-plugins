import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { DistillPaths } from "./config";
import type { StoredLesson } from "./lessons";
import {
  isValidManagedSkillName,
  MAX_MANAGED_SKILL_BYTES,
  sanitizeManagedDescription,
  sanitizeSkillName,
  toSkillFrontmatter,
} from "./skill-rules";
import { withStoreLock } from "./lessons";
import { fileExists } from "./util";

/**
 * The only write path in distill: an approval turns a lesson into a dated, append-only
 * section of an existing skill, a minted skill when nothing matches, or a section of an
 * existing subagent prompt (ADR-0003, D6).
 *
 * The rules the loader imposes come from `src/skill-rules.ts` — the host's own managed-skill
 * module mirrored verbatim, because a compiled host cannot serve that subpath (ADR-0011): a
 * name outside `^[a-z0-9][a-z0-9-]{0,63}$` throws, a description passing through
 * `sanitizeManagedDescription` cannot break out of the `<skills>` listing, the size cap is
 * measured on the final file's UTF-8 bytes, and a minted `SKILL.md` without a frontmatter
 * description is silently dropped by discovery — so the writer refuses to produce one instead
 * of reporting success for a skill nobody can see.
 */

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
}

export interface WritePlan {
  mode: "patch_skill" | "new_skill" | "patch_agent";
  /** The skill slug or agent name the lesson writes into. */
  target: string;
  filePath: string;
  /** The exact text the write adds, or the whole file when minting. */
  text: string;
}

export interface Inventory {
  skills: SkillEntry[];
  agents: string[];
}

export function skillRoot(paths: DistillPaths): string {
  return path.join(paths.projectRoot, ".omp", "skills");
}

export function agentRoot(paths: DistillPaths): string {
  return path.join(paths.projectRoot, ".omp", "agents");
}

/** The project's skills, for the overlap check that decides patch-versus-mint. */
export async function skillInventory(paths: DistillPaths): Promise<SkillEntry[]> {
  const root = skillRoot(paths);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);

  const skills: SkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await Bun.file(filePath).text();
    } catch {
      continue;
    }
    const { frontmatter } = parseFrontmatter(content);
    skills.push({
      name: typeof frontmatter.name === "string" ? frontmatter.name : entry.name,
      description: typeof frontmatter.description === "string" ? frontmatter.description : "",
      filePath,
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

/** The project's subagent prompts, by file stem. */
export async function agentInventory(paths: DistillPaths): Promise<string[]> {
  const entries = await fs.readdir(agentRoot(paths), { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => entry.name.slice(0, -".md".length))
    .sort();
}

export async function readInventory(paths: DistillPaths): Promise<Inventory> {
  const [skills, agents] = await Promise.all([skillInventory(paths), agentInventory(paths)]);
  return { skills, agents };
}

/**
 * Renders the write a lesson implies, and refuses the ones the loader would silently drop
 * or the operator would not want: a missing target, a name outside the allowlist, a
 * description that sanitizes to nothing, a minted skill that already exists.
 */
export async function planWrite(
  paths: DistillPaths,
  lesson: StoredLesson,
  now: Date = new Date(),
): Promise<WritePlan> {
  const section = renderLessonSection(lesson, now);

  if (lesson.kind === "agent_prompt") {
    const name = lesson.target.trim();
    if (!isValidManagedSkillName(name)) {
      throw new Error(`"${lesson.target}" is not a usable agent name: lowercase letters, digits and hyphens only.`);
    }
    const filePath = path.join(agentRoot(paths), `${name}.md`);
    if (!(await fileExists(filePath))) {
      throw new Error(`No agent prompt .omp/agents/${name}.md in this project; distill only patches existing ones.`);
    }
    return { mode: "patch_agent", target: name, filePath, text: section };
  }

  const name = sanitizeSkillName(lesson.target);

  if (lesson.kind === "new_skill") {
    const filePath = path.join(skillRoot(paths), name, "SKILL.md");
    if (await fileExists(filePath)) {
      throw new Error(`Skill ${name} already exists at .omp/skills/${name}/SKILL.md; propose a patch instead.`);
    }
    const description = sanitizeManagedDescription(lesson.title);
    if (description === "") {
      throw new Error(
        "The lesson's title sanitizes to an empty description, and the skill loader drops a SKILL.md without one.",
      );
    }
    return {
      mode: "new_skill",
      target: name,
      filePath,
      text: `${toSkillFrontmatter(name, description)}\n${lesson.body.trim()}\n`,
    };
  }

  const filePath = path.join(skillRoot(paths), name, "SKILL.md");
  if (!(await fileExists(filePath))) {
    throw new Error(`No skill .omp/skills/${name}/SKILL.md in this project; propose a new_skill instead.`);
  }
  return { mode: "patch_skill", target: name, filePath, text: section };
}

export interface WriteResult {
  path: string;
  bytes: number;
}

/**
 * Applies a plan. Appends use `O_APPEND`, mints create with `O_CREAT|O_EXCL`, and the size
 * cap is checked against the final file's UTF-8 bytes before anything is written. The whole
 * check-and-write runs under the project's store lock, so two approvals cannot both pass the
 * cap and land past it (ADR-0003's serialized mutations).
 */
export async function applyWrite(
  paths: DistillPaths,
  plan: WritePlan,
): Promise<WriteResult> {
  return await withStoreLock(paths, () => writePlan(plan));
}

async function writePlan(plan: WritePlan): Promise<WriteResult> {
  if (plan.mode === "new_skill") {
    const bytes = Buffer.byteLength(plan.text, "utf8");
    if (bytes > MAX_MANAGED_SKILL_BYTES) {
      throw new Error(`${plan.filePath} would be ${bytes} bytes, over the ${MAX_MANAGED_SKILL_BYTES}-byte cap.`);
    }
    await fs.mkdir(path.dirname(plan.filePath), { recursive: true });
    const handle = await fs.open(plan.filePath, "wx");
    try {
      await handle.writeFile(plan.text, "utf8");
    } finally {
      await handle.close();
    }
    return { path: plan.filePath, bytes };
  }

  const stats = await fs.lstat(plan.filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to write through the symlink ${plan.filePath}.`);
  }
  if (stats.nlink > 1) {
    throw new Error(`Refusing to overwrite ${plan.filePath}: it has ${stats.nlink} hard links.`);
  }

  const addition = `\n${plan.text}`;
  const finalBytes = stats.size + Buffer.byteLength(addition, "utf8");
  if (finalBytes > MAX_MANAGED_SKILL_BYTES) {
    throw new Error(`${plan.filePath} would reach ${finalBytes} bytes, over the ${MAX_MANAGED_SKILL_BYTES}-byte cap.`);
  }

  const handle = await fs.open(plan.filePath, "a");
  try {
    await handle.writeFile(addition, "utf8");
  } finally {
    await handle.close();
  }
  return { path: plan.filePath, bytes: finalBytes };
}

/** The dated section an approved lesson appends; hand-written prose above it is never touched. */
export function renderLessonSection(lesson: StoredLesson, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return [
    `## Lesson — ${date}`,
    "",
    lesson.body.trim(),
    "",
    `_Distill lesson \`${lesson.id}\` from session \`${lesson.provenance.sessionId}\`; cited records and excerpts in \`.omp/distill/lessons/${lesson.id}.json\`._`,
    "",
  ].join("\n");
}

