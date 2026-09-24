import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { DistillPaths } from "./config";
import { APPEND_SYSTEM_TARGET, parseAppliesTo, type RuleTrigger } from "./contract";
import { type StoredLesson, withStoreLock } from "./lessons";
import {
  isValidManagedSkillName,
  MAX_MANAGED_SKILL_BYTES,
  sanitizeManagedDescription,
  sanitizeSkillName,
  toSkillFrontmatter,
} from "./skill-rules";
import { fileExists, messageOf } from "./util";

/**
 * The only write path in distill (ADR-0003, ADR-0012): an approval writes into one of the
 * project's own surfaces, editing what exists before adding anything.
 *
 * - `<target>` skill          → `.omp/skills/<slug>/SKILL.md`, patched or minted
 * - `<slug>/<name>` reference → `.omp/skills/<slug>/references/<name>.md`, plus the line
 *                               pointing at it from that skill's `SKILL.md`
 * - rule                      → `.omp/rules/<name>.md`, with a trigger in its frontmatter
 * - agent prompt              → `.omp/agents/<name>.md`, which must already exist
 * - append system             → `.omp/APPEND_SYSTEM.md`
 *
 * Patches are append-only dated sections, so hand-written prose is never rewritten. Minted
 * skills carry a frontmatter description or are refused: the loader drops a `SKILL.md`
 * without one, silently, and the writer must not report success for a skill nobody can see.
 */

export interface PlannedWrite {
  path: string;
  /**
   * `create` refuses an existing file, `append` adds after its current bytes, and `splice` takes
   * lines out of one — a surface that has grown past what a session needs is worth trimming, and
   * the plugin's own review is the only place that can be approved.
   */
  mode: "create" | "append" | "splice";
  /** The bytes the write contributes; empty for a pure removal. */
  text: string;
  /**
   * `splice` only: the lines to take out, as the lesson quoted them. Matched against the file's own
   * lines with whitespace trimmed at both ends, so a lesson that quotes a paragraph does not have to
   * reproduce its indentation byte for byte; the lines actually removed are the file's.
   */
  remove?: string;
  /** The loader's cap, for the files it applies to. */
  capBytes?: number;
}

/** The project's permanent main-agent layer, which `append_system` targets. */
export function appendSystemPath(paths: DistillPaths): string {
  return path.join(paths.projectRoot, ".omp", APPEND_SYSTEM_TARGET);
}

export interface WritePlan {
  /** What the operator sees: the slug, agent, rule name, or the literal target. */
  target: string;
  /** The files this approval writes, in order. */
  writes: PlannedWrite[];
}

export function skillRoot(paths: DistillPaths): string {
  return path.join(paths.projectRoot, ".omp", "skills");
}

export function agentRoot(paths: DistillPaths): string {
  return path.join(paths.projectRoot, ".omp", "agents");
}

export function ruleRoot(paths: DistillPaths): string {
  return path.join(paths.projectRoot, ".omp", "rules");
}

/**
 * Renders the writes a lesson implies, and refuses the ones the loader would silently drop
 * or the operator would not want: a missing target, a name outside the allowlist, a
 * description that sanitizes to nothing, a rule whose trigger contradicts the one on disk.
 */
export type WritableLesson = Pick<StoredLesson, "title" | "body" | "target" | "id" | "provenance"> &
  Partial<Pick<StoredLesson, "applies_to" | "removes">> & { kind: string };

export async function planWrite(
  paths: DistillPaths,
  lesson: WritableLesson,
  now: Date = new Date(),
): Promise<WritePlan> {
  const plan = await planAddition(paths, lesson, now);
  const removes = lesson.removes?.trim();
  if (removes === undefined || removes === "") return plan;

  // A trim applies to the lesson's own file, which is the first write of every plan: the reference
  // itself for a reference, the surface for everything else. A reference's pointer write is
  // dropped with it — a lesson that trims a reference is not the lesson that minted it, and one
  // that tried to would be refused below for trimming a file that does not exist yet.
  const target = plan.writes[0];
  if (target === undefined) return plan;
  return { ...plan, writes: await spliceWrite(target, removes, lesson.body) };
}

/**
 * Turns one append (or a create that never happened) into a splice: the quoted lines come out, the
 * lesson's body — if it has one — goes where they were.
 */
async function spliceWrite(write: PlannedWrite, removes: string, body: string): Promise<PlannedWrite[]> {
  if (write.mode === "create") {
    throw new Error(
      `${write.path} does not exist yet, so there is nothing in it to remove. Propose the file with the lesson's body alone, or point the removal at the file that has the text.`,
    );
  }
  const content = await readText(write.path);
  if (content === undefined) throw new Error(`${write.path} could not be read, so nothing can be removed from it.`);

  const found = findRemoval(content.split("\n"), removes);
  if (found === undefined) {
    throw new Error(
      `${write.path} does not contain the text this lesson removes, so it may have changed since the session was read. Nothing was written.`,
    );
  }
  if (found.occurrences > 1) {
    throw new Error(
      `The text this lesson removes appears ${found.occurrences} times in ${write.path}; quote enough of it to name one place.`,
    );
  }

  const text = body.trim() === "" ? "" : `${body.trim()}\n`;
  const remove = found.lines.join("\n");
  // The case trims exist for is a surface already near the loader's cap, where a replacement longer
  // than what it replaces pushes the file over and the host drops the whole skill without a word.
  // The planner has the file in hand, so it refuses now — as a blocked lesson — rather than letting
  // the operator approve a write that cannot land.
  const projected = spliceContent(content, remove, text);
  if (write.capBytes !== undefined && Buffer.byteLength(projected, "utf8") > write.capBytes) {
    throw new Error(
      `${write.path} would reach ${Buffer.byteLength(projected, "utf8")} bytes, over the ${write.capBytes}-byte cap. The removal has to leave it shorter than the lesson it replaces.`,
    );
  }
  return [{ ...write, mode: "splice", remove, text }];
}

/**
 * The file as it is after the quoted lines are taken out and the lesson's text put where they were.
 * One place for this surgery, so the size the planner checks is the size the applier writes.
 */
export function spliceContent(content: string, remove: string, text: string): string {
  // The quoted lines are whole lines: take their terminator with them, or a trim leaves a blank line
  // where the removed block used to be.
  const withTerminator = `${remove}\n`;
  const cutting = content.includes(withTerminator) ? withTerminator : remove;
  const at = content.indexOf(cutting);
  if (at === -1) throw new Error("the text to remove is not in the file any more.");
  return `${content.slice(0, at)}${text}${content.slice(at + cutting.length)}`;
}

/**
 * Where a lesson's quoted lines are in a file. Matching trims whitespace at both ends of each line,
 * so a lesson does not have to reproduce indentation, and skips over the blank lines *inside* a
 * quoted block while leaving the blank lines at its edges alone — a trim takes the block and leaves
 * the file's spacing as it was. `lines` are the file's own, so what comes out is what was quoted,
 * not what the lesson thought it quoted.
 */
export function findRemoval(
  lines: readonly string[],
  removes: string,
): { start: number; lines: string[]; occurrences: number } | undefined {
  const wanted = removes
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
  if (wanted.length === 0) return undefined;

  let start = -1;
  let found: string[] = [];
  let occurrences = 0;
  for (let index = 0; index < lines.length; index++) {
    const window: string[] = [];
    for (let cursor = index; window.filter(line => line.trim() !== "").length < wanted.length && cursor < lines.length; cursor++) {
      window.push(lines[cursor] ?? "");
    }
    const quoted = window.map(line => line.trim()).filter(line => line !== "");
    if (quoted.length !== wanted.length || !quoted.every((line, offset) => line === wanted[offset])) continue;

    occurrences += 1;
    if (start !== -1) continue;
    let first = 0;
    while (first < window.length && (window[first] ?? "").trim() === "") first += 1;
    let last = window.length;
    while (last > first && (window[last - 1] ?? "").trim() === "") last -= 1;
    start = index + first;
    found = window.slice(first, last);
    index += last - 1;
  }

  return start === -1 ? undefined : { start, lines: found, occurrences };
}

/** What the lesson adds, before any trimming it also asks for. */
async function planAddition(paths: DistillPaths, lesson: WritableLesson, now: Date): Promise<WritePlan> {
  switch (lesson.kind) {
    case "skill_reference":
      return await planReference(paths, lesson, now);
    case "rule":
      return await planRule(paths, lesson, now);
    case "agent_prompt":
      return await planAgent(paths, lesson, now);
    case "append_system":
      return await planAppendSystem(paths, lesson, now);
    default:
      return await planSkill(paths, lesson, now);
  }
}

/** A skill is patched when the slug exists and minted when it does not — never duplicated. */
async function planSkill(paths: DistillPaths, lesson: WritableLesson, now: Date): Promise<WritePlan> {
  const name = sanitizeSkillName(lesson.target);
  const filePath = path.join(skillRoot(paths), name, "SKILL.md");

  if (await fileExists(filePath)) {
    return {
      target: name,
      writes: [{ path: filePath, mode: "append", text: renderLessonSection(lesson), capBytes: MAX_MANAGED_SKILL_BYTES }],
    };
  }

  const description = sanitizeManagedDescription(lesson.title);
  if (description === "") {
    throw new Error(
      "The lesson's title sanitizes to an empty description, and the skill loader drops a SKILL.md without one.",
    );
  }
  const text = `${toSkillFrontmatter(name, description)}\n${lesson.body.trim()}\n`;
  return {
    target: name,
    writes: [{ path: filePath, mode: "create", text, capBytes: MAX_MANAGED_SKILL_BYTES }],
  };
}

/**
 * A reference holds a sub-problem's detail; the skill stays the entry point, so the approval
 * writes the file and the line that points at it from `SKILL.md`.
 */
async function planReference(paths: DistillPaths, lesson: WritableLesson, now: Date): Promise<WritePlan> {
  const [slug, name] = lesson.target.split("/");
  if (!slug || !name) throw new Error(`"${lesson.target}" must be "<skill-slug>/<reference-name>".`);

  const skillPath = path.join(skillRoot(paths), sanitizeSkillName(slug), "SKILL.md");
  if (!(await fileExists(skillPath))) {
    throw new Error(`No skill .omp/skills/${slug}/SKILL.md in this project; mint the skill before its reference.`);
  }

  const referencePath = path.join(path.dirname(skillPath), "references", `${sanitizeSkillName(name)}.md`);
  if (await fileExists(referencePath)) {
    throw new Error(`.omp/skills/${slug}/references/${name}.md already exists; propose an edit to it instead.`);
  }

  const referenceText = `# ${lesson.title.trim()}\n\n${lesson.body.trim()}\n`;
  const pointer = await renderReferencePointer(skillPath, name, lesson.title, now);
  return {
    target: lesson.target,
    writes: [
      { path: referencePath, mode: "create", text: referenceText },
      { path: skillPath, mode: "append", text: pointer, capBytes: MAX_MANAGED_SKILL_BYTES },
    ],
  };
}

async function planRule(paths: DistillPaths, lesson: WritableLesson, now: Date): Promise<WritePlan> {
  const name = sanitizeSkillName(lesson.target);
  const filePath = path.join(ruleRoot(paths), `${name}.md`);
  const existing = await readText(filePath);
  const parsed = parseAppliesTo(lesson.applies_to);
  if (parsed.problems.length > 0) {
    // Proposal time refuses these, so reaching it means the lesson file was edited by hand: fail
    // loudly rather than write a rule whose frontmatter says something nobody asked for.
    throw new Error(`The stored lesson's applies_to is not usable: ${parsed.problems.join("; ")}`);
  }
  const trigger = parsed.trigger;

  if (existing !== undefined) {
    if (trigger !== undefined && !(await ruleTriggerMatches(existing, trigger))) {
      throw new Error(
        `.omp/rules/${name}.md is fired by different conditions; its trigger is its frontmatter, which a patch does not touch. Use a new rule name, or drop applies_to to add to its body.`,
      );
    }
    const section = renderLessonSection(lesson);
    return {
      target: name,
      writes: [{ path: filePath, mode: "append", text: section }],
    };
  }

  const description = sanitizeManagedDescription(lesson.title);
  if (description === "") {
    throw new Error("The lesson's title sanitizes to an empty description, and a rule without one is never listed.");
  }
  const text = `${toRuleFrontmatter(description, trigger)}\n${lesson.body.trim()}\n`;
  return {
    target: name,
    writes: [{ path: filePath, mode: "create", text }],
  };
}

async function planAgent(paths: DistillPaths, lesson: WritableLesson, now: Date): Promise<WritePlan> {
  const name = lesson.target.trim();
  if (!isValidManagedSkillName(name)) {
    throw new Error(`"${lesson.target}" is not a usable agent name: lowercase letters, digits and hyphens only.`);
  }
  const filePath = path.join(agentRoot(paths), `${name}.md`);
  if (!(await fileExists(filePath))) {
    throw new Error(`No agent prompt .omp/agents/${name}.md in this project; distill only patches existing ones.`);
  }
  const section = renderLessonSection(lesson);
  return { target: name, writes: [{ path: filePath, mode: "append", text: section }] };
}

/** The loudest surface: what lands here rides every request in the project. */
async function planAppendSystem(paths: DistillPaths, lesson: WritableLesson, now: Date): Promise<WritePlan> {
  if (lesson.target.trim() !== APPEND_SYSTEM_TARGET) {
    throw new Error(`An append_system lesson targets ${APPEND_SYSTEM_TARGET}, not "${lesson.target}".`);
  }
  const filePath = appendSystemPath(paths);
  const section = renderLessonSection(lesson);
  return {
    target: APPEND_SYSTEM_TARGET,
    writes: [{ path: filePath, mode: (await fileExists(filePath)) ? "append" : "create", text: section }],
  };
}

export interface WriteResult {
  /** The files written, in the order they were written. */
  written: string[];
}

/**
 * Applies a plan. Appends use `O_APPEND`, creates use `O_CREAT|O_EXCL`, every byte cap is
 * checked against the final file before anything is written, and a symlink anywhere along
 * the trail — or a hard-linked target — is refused. The whole plan runs under the project's
 * store lock, so two approvals cannot interleave.
 */
export async function applyWrite(paths: DistillPaths, plan: WritePlan): Promise<WriteResult> {
  return await withStoreLock(paths, async () => {
    const written: string[] = [];
    for (const write of plan.writes) {
      if (write.mode === "create") written.push(await createFile(write));
      else if (write.mode === "splice") written.push(await spliceFile(write));
      else written.push(await appendFile(write));
    }
    return { written };
  });
}

async function createFile(write: PlannedWrite): Promise<string> {
  const bytes = Buffer.byteLength(write.text, "utf8");
  if (write.capBytes !== undefined && bytes > write.capBytes) {
    throw new Error(`${write.path} would be ${bytes} bytes, over the ${write.capBytes}-byte cap.`);
  }
  await refuseSymlinkTrail(write.path);
  await fs.mkdir(path.dirname(write.path), { recursive: true });

  const handle = await fs.open(write.path, "wx");
  try {
    await handle.writeFile(write.text, "utf8");
  } finally {
    await handle.close();
  }
  return write.path;
}

/** Takes the planned lines out and puts the lesson's text where they were, in one write. */
async function spliceFile(write: PlannedWrite): Promise<string> {
  if (write.remove === undefined) throw new Error(`${write.path} was planned as a splice with nothing to remove.`);
  const stats = await fs.lstat(write.path);
  if (stats.isSymbolicLink()) throw new Error(`Refusing to write through the symlink ${write.path}.`);
  if (stats.nlink > 1) throw new Error(`Refusing to overwrite ${write.path}: it has ${stats.nlink} hard links.`);

  const content = await Bun.file(write.path).text();
  let next: string;
  try {
    next = spliceContent(content, write.remove, write.text);
  } catch (error) {
    throw new Error(`${write.path} changed since this was planned: ${messageOf(error)} Nothing was written.`);
  }
  if (write.capBytes !== undefined && Buffer.byteLength(next, "utf8") > write.capBytes) {
    throw new Error(`${write.path} would reach ${Buffer.byteLength(next, "utf8")} bytes, over the ${write.capBytes}-byte cap.`);
  }

  // A fresh file next to the old one, then the rename: a crash mid-write never leaves a half-trimmed
  // surface behind, which matters more here than for an append.
  const temp = `${write.path}.distill-${process.pid}.tmp`;
  await Bun.write(temp, next);
  await fs.rename(temp, write.path);
  return write.path;
}

async function appendFile(write: PlannedWrite): Promise<string> {
  const stats = await fs.lstat(write.path);
  if (stats.isSymbolicLink()) throw new Error(`Refusing to write through the symlink ${write.path}.`);
  if (stats.nlink > 1) throw new Error(`Refusing to overwrite ${write.path}: it has ${stats.nlink} hard links.`);

  const addition = `\n${write.text}`;
  const finalBytes = stats.size + Buffer.byteLength(addition, "utf8");
  if (write.capBytes !== undefined && finalBytes > write.capBytes) {
    throw new Error(`${write.path} would reach ${finalBytes} bytes, over the ${write.capBytes}-byte cap.`);
  }

  const handle = await fs.open(write.path, "a");
  try {
    await handle.writeFile(addition, "utf8");
  } finally {
    await handle.close();
  }
  return write.path;
}

/** Rejects a symlink anywhere between the project's `.omp/` and the file being created. */
async function refuseSymlinkTrail(target: string): Promise<void> {
  let dir = path.dirname(target);
  const stop = path.dirname(path.dirname(dir));
  while (dir.length > stop.length) {
    const stats = await fs.lstat(dir).catch(() => undefined);
    if (stats?.isSymbolicLink()) throw new Error(`Refusing to write through the symlink ${dir}.`);
    dir = path.dirname(dir);
  }
}

/**
 * What an approved lesson appends to a file that already holds content: the lesson's own text, and
 * nothing else. The dated heading and provenance footnote it used to carry were decoration inside a
 * surface the next session reads and pays for by the token; where a lesson came from is in the
 * ledger's decision row, which is where provenance belongs.
 */
export function renderLessonSection(lesson: WritableLesson): string {
  // The separator belongs to the write (`appendFile` adds `"\n" + text`), not here: two leading
  // newlines are a stray blank line in every appended surface.
  return `${lesson.body.trim()}\n`;
}

/** The skill's pointer to a reference: continued under `## References` when that is its last section. */
async function renderReferencePointer(skillPath: string, name: string, title: string, now: Date): Promise<string> {
  const content = (await readText(skillPath)) ?? "";
  const line = `- [\`references/${name}.md\`](references/${name}.md) — ${title.trim()}`;
  const hasReferencesSection = /^##\s+References\s*$/m.test(content);
  const referencesIsLast = hasReferencesSection && content.trimEnd().lastIndexOf("## References") > content.trimEnd().lastIndexOf("\n## ");
  return referencesIsLast ? `${line}\n` : `## References\n\n${line}\n`;
}

/** Does the rule's own frontmatter already express every clause this lesson asks for? */
async function ruleTriggerMatches(content: string, trigger: RuleTrigger): Promise<boolean> {
  const { frontmatter } = parseFrontmatter(content);
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];

  if (trigger.always === true && frontmatter.alwaysApply !== true) return false;
  if (trigger.condition !== undefined && !list(frontmatter.condition).includes(trigger.condition)) return false;
  if (trigger.ast !== undefined && !list(frontmatter.astCondition).includes(trigger.ast)) return false;
  if (trigger.globs !== undefined && !list(frontmatter.globs).includes(trigger.globs)) return false;
  if (trigger.agent !== undefined && !list(frontmatter.agents).includes(trigger.agent)) return false;
  if (trigger.scope !== undefined && !list(frontmatter.scope).includes(trigger.scope)) return false;
  if (trigger.interrupt !== undefined && frontmatter.interruptMode !== trigger.interrupt) return false;
  return true;
}

/** Rule frontmatter, mirroring the host's `RuleFrontmatter` keys. */
function toRuleFrontmatter(description: string, trigger: RuleTrigger | undefined): string {
  const lines = [`description: ${yamlScalar(description)}`];
  const list = (key: string, value: string): void => {
    lines.push(`${key}:`, `  - ${yamlScalar(value)}`);
  };
  if (trigger?.always === true) lines.push("alwaysApply: true");
  if (trigger?.condition !== undefined) list("condition", trigger.condition);
  if (trigger?.ast !== undefined) list("astCondition", trigger.ast);
  if (trigger?.globs !== undefined) list("globs", trigger.globs);
  if (trigger?.agent !== undefined) list("agents", trigger.agent);
  if (trigger?.scope !== undefined) list("scope", trigger.scope);
  if (trigger?.interrupt !== undefined) lines.push(`interruptMode: ${trigger.interrupt}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Single-quoted YAML: always valid for these strings, and it cannot swallow a `#` or a `:`. */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function markdownStems(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => entry.name.slice(0, -".md".length))
    .sort();
}

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await Bun.file(filePath).text();
  } catch {
    return undefined;
  }
}
