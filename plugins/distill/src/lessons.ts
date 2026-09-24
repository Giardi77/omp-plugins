import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils";
import type { DistillPaths } from "./config";
import {
  ANSWER_CONTRACT_VERSION,
  type LessonKind,
  lessonId,
  type ProposedLesson,
  type ResolvedCitation,
} from "./contract";
import { isRecord } from "./util";

/**
 * Lessons and the decisions ledger, both project-local (ADR-0002). A proposed lesson lives
 * outside every skill root — the project runs skills in denylist mode, so a new directory
 * under `.omp/skills/` becomes active on the next session with no config change, and only an
 * approval may write there (ADR-0003).
 *
 * Every mutation runs under a file lock so two omp processes cannot corrupt the store
 * (user story 36). The lock file itself lives under `tmp/`, which is gitignored.
 */

export type LessonState = "proposed" | "approved" | "denied";

export interface LessonCitation {
  citation: string;
  /** Verbatim slice of the cited record, extracted by the plugin, never quoted by the model. */
  excerpt: string;
}

export interface LessonProvenance {
  sessionId: string;
  /** The trace ids the evaluation covered, one per trace. */
  traceSessionIds: string[];
  contractVersion: number;
  promptSha256: string;
  model?: string;
}

export interface StoredLesson {
  id: string;
  state: LessonState;
  kind: LessonKind;
  title: string;
  body: string;
  target: string;
  rationale: string;
  citations: LessonCitation[];
  createdAt: string;
  decidedAt?: string;
  /** The one-line reason a denial carries, when the operator gave one. */
  reason?: string;
  /** Files an approval wrote into; purge names them rather than unwriting them. */
  written?: string[];
  provenance: LessonProvenance;
}

/**
 * The ledger's vocabulary (ADR-0008): a run either produced lessons or failed. An empty run
 * — completed, proposed nothing — is recorded as a failure with reason `empty`, because that
 * is the only evidence the evaluator missed something; only technical faults leave a trace
 * eligible for the next scan.
 */
export type EvaluationOutcome = "lessons" | "failed";

export const EMPTY_REASON = "empty";

/** Whether an evaluation ran to completion, whatever it yielded. */
export function evaluationCompleted(record: EvaluationRecord): boolean {
  return record.outcome === "lessons" || record.reason === EMPTY_REASON;
}

export interface EvaluationRecord {
  kind: "evaluation";
  at: string;
  sessionId: string;
  sessionFile: string;
  traceSessionIds: string[];
  outcome: EvaluationOutcome;
  /** Why a failed run failed: "empty", "timeout", a parse or read fault. */
  reason?: string;
  verdict: string;
  lessonIds: string[];
  model?: string;
  contractVersion: number;
  promptSha256: string;
  /** Files the evaluator opened, reconstructed from its own transcript (D21). */
  reads: string[];
}

export interface DecisionRecord {
  kind: "decision";
  at: string;
  lessonId: string;
  decision: "approved" | "denied";
  reason?: string;
  written?: string[];
}

export type LedgerRecord = EvaluationRecord | DecisionRecord;

export function lessonFilePath(paths: DistillPaths, id: string): string {
  return path.join(paths.lessonsDir, `${id}.json`);
}

export async function readLesson(paths: DistillPaths, id: string): Promise<StoredLesson | undefined> {
  let content: string;
  try {
    content = await Bun.file(lessonFilePath(paths, id)).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  return isStoredLesson(parsed) ? parsed : undefined;
}

export async function listLessons(
  paths: DistillPaths,
  state?: LessonState,
): Promise<StoredLesson[]> {
  let names: string[];
  try {
    names = await fs.readdir(paths.lessonsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw error;
  }

  const lessons: StoredLesson[] = [];
  for (const name of names.filter(entry => entry.endsWith(".json")).sort()) {
    const lesson = await readLesson(paths, name.slice(0, -".json".length));
    if (!lesson) continue;
    if (state && lesson.state !== state) continue;
    lessons.push(lesson);
  }
  return lessons.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export interface ProposalInput {
  lesson: ProposedLesson;
  resolved: ResolvedCitation[];
}

export interface SaveResult {
  created: StoredLesson[];
  /** Ids of proposals identical to a lesson already on record, in any state. */
  duplicates: string[];
}

/**
 * Records proposed lessons. A proposal identical to one already stored — proposed, approved
 * or denied — is a duplicate by construction (`lessonId` hashes the normalized proposal), so
 * a denied lesson cannot come back as if it were new (ADR-0008's predecessor lesson).
 */
export async function saveProposals(
  paths: DistillPaths,
  proposals: ProposalInput[],
  provenance: LessonProvenance,
  now: string = new Date().toISOString(),
): Promise<SaveResult> {
  return await withStoreLock(paths, async () => {
    await fs.mkdir(paths.lessonsDir, { recursive: true });
    const created: StoredLesson[] = [];
    const duplicates: string[] = [];

    for (const proposal of proposals) {
      const id = lessonId(proposal.lesson);
      if ((await readLesson(paths, id)) !== undefined) {
        duplicates.push(id);
        continue;
      }
      const lesson: StoredLesson = {
        id,
        state: "proposed",
        kind: proposal.lesson.kind,
        title: proposal.lesson.title,
        body: proposal.lesson.body,
        target: proposal.lesson.target,
        rationale: proposal.lesson.rationale,
        citations: proposal.resolved.map(citation => ({ citation: citation.citation, excerpt: citation.excerpt })),
        createdAt: now,
        provenance,
      };
      await Bun.write(lessonFilePath(paths, id), `${JSON.stringify(lesson, null, 2)}\n`);
      created.push(lesson);
    }

    return { created, duplicates };
  });
}

/** Decides a lesson and appends its ledger row in one locked step: the two never diverge. */
export async function decideLesson(
  paths: DistillPaths,
  id: string,
  decision: { state: "approved" | "denied"; reason?: string; written?: string[] },
  now: string = new Date().toISOString(),
): Promise<StoredLesson> {
  return await withStoreLock(paths, async () => {
    const lesson = await readLesson(paths, id);
    if (!lesson) throw new Error(`No lesson ${id} under ${paths.lessonsDir}.`);
    const next: StoredLesson = {
      ...lesson,
      state: decision.state,
      decidedAt: now,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.written === undefined ? {} : { written: decision.written }),
    };
    await Bun.write(lessonFilePath(paths, id), `${JSON.stringify(next, null, 2)}\n`);
    await fs.mkdir(paths.root, { recursive: true });
    await fs.appendFile(
      paths.decisionsPath,
      `${JSON.stringify(
        decisionRecord({
          lessonId: id,
          decision: decision.state,
          reason: decision.reason,
          written: decision.written,
          at: now,
        }),
      )}\n`,
    );
    return next;
  });
}

export async function appendLedger(paths: DistillPaths, record: LedgerRecord): Promise<void> {
  await withStoreLock(paths, async () => {
    await fs.mkdir(paths.root, { recursive: true });
    await fs.appendFile(paths.decisionsPath, `${JSON.stringify(record)}\n`);
  });
}

export async function readLedger(paths: DistillPaths): Promise<LedgerRecord[]> {
  let content: string;
  try {
    content = await Bun.file(paths.decisionsPath).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    throw error;
  }

  const records: LedgerRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isLedgerRecord(parsed)) records.push(parsed);
  }
  return records;
}

/**
 * Eligibility is per trace and reads execution, not outcome: a trace retires once an
 * evaluation that ran to completion covered it, whatever that evaluation yielded. Only
 * technical faults leave a trace eligible, and `purge` is the only re-opener (ADR-0008).
 */
export async function retiredTraceSessionIds(paths: DistillPaths): Promise<Set<string>> {
  const retired = new Set<string>();
  for (const record of await readLedger(paths)) {
    if (record.kind !== "evaluation" || !evaluationCompleted(record)) continue;
    for (const traceSessionId of record.traceSessionIds) retired.add(traceSessionId);
  }
  return retired;
}

export interface PurgeResult {
  lessonsRemoved: number;
  decisionsRemoved: number;
  /** Files approved lessons were already written into; purge never unwrites them. */
  leftAlone: string[];
}

/** Cancels nothing by itself — the caller stops the run first — then deletes distill's copies. */
export async function purge(paths: DistillPaths): Promise<PurgeResult> {
  return await withStoreLock(paths, async () => {
    const lessons = await listLessons(paths);
    const leftAlone = [...new Set(lessons.flatMap(lesson => lesson.written ?? []))].sort();
    const decisionsRemoved = (await readLedger(paths)).length;

    await fs.rm(paths.lessonsDir, { recursive: true, force: true });
    await fs.rm(paths.decisionsPath, { force: true });
    await fs.rm(paths.tmpDir, { recursive: true, force: true });

    return { lessonsRemoved: lessons.length, decisionsRemoved, leftAlone };
  });
}

/**
 * Runs `operation` under the project's store lock. Lock anchors live under the gitignored
 * `.locks/` — not under `tmp/`, which purge deletes while a lock may still be held — and
 * their directory is created first because the native lock is non-recursive.
 */
export async function withStoreLock<T>(paths: DistillPaths, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(paths.locksDir, { recursive: true });
  return await withFileLock(path.join(paths.locksDir, "store"), operation, { retries: 200, retryDelayMs: 50 });
}

export function isStoredLesson(value: unknown): value is StoredLesson {
  if (!isRecord(value)) return false;
  const state = value.state;
  return (
    typeof value.id === "string" &&
    (state === "proposed" || state === "approved" || state === "denied") &&
    typeof value.kind === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    typeof value.target === "string" &&
    Array.isArray(value.citations) &&
    isRecord(value.provenance)
  );
}

function isLedgerRecord(value: unknown): value is LedgerRecord {
  if (!isRecord(value) || typeof value.at !== "string") return false;
  if (value.kind === "decision") {
    return typeof value.lessonId === "string" && (value.decision === "approved" || value.decision === "denied");
  }
  if (value.kind !== "evaluation") return false;
  return (
    typeof value.sessionId === "string" &&
    Array.isArray(value.traceSessionIds) &&
    (value.outcome === "lessons" || value.outcome === "failed")
  );
}

export function evaluationRecord(input: {
  sessionId: string;
  sessionFile: string;
  traceSessionIds: string[];
  /** The run's operator-facing outcome; `empty` is recorded as a failure with reason `empty`. */
  outcome: EvaluationOutcome | "empty";
  reason?: string;
  verdict?: string;
  lessonIds?: string[];
  model?: string;
  promptSha256: string;
  reads?: string[];
  at?: string;
}): EvaluationRecord {
  const empty = input.outcome === "empty";
  const outcome: EvaluationOutcome = input.outcome === "empty" ? "failed" : input.outcome;
  return {
    kind: "evaluation",
    at: input.at ?? new Date().toISOString(),
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    traceSessionIds: input.traceSessionIds,
    outcome,
    ...(empty ? { reason: EMPTY_REASON } : input.reason === undefined ? {} : { reason: input.reason }),
    verdict: input.verdict ?? "",
    lessonIds: input.lessonIds ?? [],
    ...(input.model === undefined ? {} : { model: input.model }),
    contractVersion: ANSWER_CONTRACT_VERSION,
    promptSha256: input.promptSha256,
    reads: input.reads ?? [],
  };
}

export function decisionRecord(input: {
  lessonId: string;
  decision: "approved" | "denied";
  reason?: string;
  written?: string[];
  at?: string;
}): DecisionRecord {
  return {
    kind: "decision",
    at: input.at ?? new Date().toISOString(),
    lessonId: input.lessonId,
    decision: input.decision,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.written === undefined ? {} : { written: input.written }),
  };
}
