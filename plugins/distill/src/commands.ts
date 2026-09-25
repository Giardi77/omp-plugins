import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { acquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils";
import { loadTraceBundle } from "./bundle";
import {
  distillPaths,
  readConfig,
  resolveProjectRoot,
  setEnabled,
  setupProject,
  type DistillConfig,
  type DistillPaths,
} from "./config";
import { ANSWER_CONTRACT_VERSION } from "./contract";
import { runEvaluation, type EvaluatorModel } from "./evaluator";
import {
  acquireScanLock,
  buildScanJob,
  cancelRequestPath,
  cancelScanJob,
  clearCancelRequest,
  describeScanJob,
  readScanJob,
  scanJobPath,
  scanLockHeld,
  startScanJob,
  writeScanJob,
  type ScanJob,
  type ScanTarget,
} from "./job";
import {
  appendLedger,
  decideLesson,
  withStoreLock,
  EMPTY_REASON,
  evaluationRecord,
  listLessons,
  purge,
  readLedger,
  retiredTraceSessionIds,
  saveProposals,
  type StoredLesson,
} from "./lessons";
import { planFileChanges, type FileChange } from "./diff";
import { runReview, type ReviewEntry } from "./review";
import { listProjectSessions, sessionTraceIds, type SessionCandidate } from "./store";
import { CLI_THINKING_LEVELS, parseCliThinkingLevel, supportedThinkingLevels } from "./thinking";
import { renderInventory, type TraceBundle } from "./trace";
import { fileExists, messageOf } from "./util";
import { applyWrite, planWrite } from "./writer";

/**
 * The seven commands of the loop (D11). Each one is a thin flow over the modules that own
 * the behaviour; nothing here decides policy.
 *
 *   /distill setup     — activate the project: config, default evaluator prompt, tmp ignore
 *   /distill enable    — turn the loop on
 *   /distill disable   — pause the loop without uninstalling anything
 *   /distill status    — what the loop knows: eligibility, proposed lessons, last verdict
 *   /distill scan      — evaluate sessions, one at a time (--limit, --session, --dry-run)
 *   /distill review    — decide the proposed lessons in a terminal window
 *   /distill purge     — forget this project's records behind a confirmation
 */

export interface DistillFlags {
  limit?: number;
  session?: string;
  dryRun: boolean;
  yes: boolean;
  model?: string;
  thinking?: string;
}

export interface DistillInvocation {
  command: string;
  rest: string[];
  flags: DistillFlags;
}

export function parseInvocation(args: string): DistillInvocation {
  const tokens = args.trim().split(/\s+/).filter(token => token !== "");
  const command = tokens.shift() ?? "";
  const flags: DistillFlags = { dryRun: false, yes: false };
  const rest: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    const [name, inlineValue] = token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
    const value = () => inlineValue ?? tokens[++index];

    switch (name) {
      case "--limit": {
        const raw = value();
        const parsed = Number.parseInt(raw ?? "", 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--limit needs a positive number (got "${raw ?? ""}")`);
        flags.limit = parsed;
        break;
      }
      case "--session":
        flags.session = value();
        break;
      case "--model":
        flags.model = value();
        break;
      case "--thinking":
        flags.thinking = value();
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--yes":
        flags.yes = true;
        break;
      default:
        rest.push(token);
    }
  }

  return { command, rest, flags };
}

const DISTILL_USAGE = [
  "/distill setup [--model <spec>] [--thinking <level>]",
  "/distill enable | disable",
  "/distill status",
  "/distill scan [--limit <n>] [--session <id|file>] [--dry-run]   (runs in the background)",
  "/distill cancel",
  "/distill review",
  "/distill purge [--yes]",
].join("\n");

export async function runDistillCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  let invocation: DistillInvocation;
  try {
    invocation = parseInvocation(args);
  } catch (error) {
    notify(ctx, messageOf(error), "error");
    return;
  }

  const projectRoot = await resolveProjectRoot(ctx.cwd);
  const paths = distillPaths(projectRoot);

  switch (invocation.command) {
    case "":
      notify(ctx, `distill — session learning for this project\n\n${DISTILL_USAGE}`, "info");
      return;
    case "setup":
      await runSetup(ctx, paths, invocation.flags);
      return;
    case "enable":
    case "disable":
      await runToggle(ctx, paths, invocation.command === "enable");
      return;
    case "status":
      await runStatus(pi, ctx, paths);
      return;
    case "scan":
      await runScan(pi, ctx, paths, invocation.flags);
      return;
    case "cancel":
      await runCancel(ctx, paths);
      return;
    case "_job":
      // The daemon's own entry point, never typed by hand: /distill scan starts it through the
      // host's broker with the journal already written.
      await runScanJob(pi, ctx, paths);
      return;
    case "review":
      await runReviewCommand(ctx, paths);
      return;
    case "purge":
      await runPurge(ctx, paths, invocation.flags);
      return;
    default:
      notify(ctx, `Unknown subcommand "${invocation.command}".\n\n${DISTILL_USAGE}`, "error");
  }
}

async function runSetup(ctx: ExtensionCommandContext, paths: DistillPaths, flags: DistillFlags): Promise<void> {
  let model = flags.model;
  let thinking = flags.thinking;

  if (ctx.hasUI && ctx.mode === "tui" && !flags.yes) {
    const choice = await pickModel(ctx);
    if (choice !== undefined) model = choice;

    // The ladder belongs to the model that will run the evaluation: the one just chosen, or — when
    // that picker was escaped — the session's own, which this config then leaves implicit.
    const evaluatorModel = model === undefined ? ctx.model : ctx.models.resolve(model);
    const level = await ctx.ui.select("Evaluator thinking level — Esc leaves it to the model", [
      ...supportedThinkingLevels(evaluatorModel),
    ]);
    if (level !== undefined) thinking = level;
  }

  if (thinking !== undefined && parseCliThinkingLevel(thinking) === undefined) {
    notify(ctx, `Unknown thinking level "${thinking}". Try one of ${CLI_THINKING_LEVELS.join(", ")}.`, "error");
    return;
  }

  const setup = await setupProject(paths.projectRoot, { model, thinking });
  const lines = [
    `${setup.evaluatorCreated ? "Created" : "Kept"} ${path.relative(paths.projectRoot, setup.paths.evaluatorPath)} — the project owns what is worth learning; edit it freely.`,
    `Wrote ${path.relative(paths.projectRoot, setup.paths.configPath)} (enabled, model: ${setup.config.model ?? "session default"}, thinking: ${setup.config.thinking ?? "model default"}).`,
    `Lessons land in ${path.relative(paths.projectRoot, setup.paths.lessonsDir)}/ and await /distill review; nothing is written into .omp/skills/ without approval.`,
  ];
  notify(ctx, lines.join("\n"), "info");
}

async function runToggle(ctx: ExtensionCommandContext, paths: DistillPaths, enabled: boolean): Promise<void> {
  const config = await readConfig(paths);
  if (!config) {
    notify(ctx, "This project has no .omp/distill/config.yaml yet; run /distill setup first.", "error");
    return;
  }
  await setEnabled(paths, enabled);
  notify(ctx, `distill is now ${enabled ? "enabled" : "disabled"} in this project.`, "info");
}

/**
 * A session is eligible while any of its traces is unretired: retirement is per trace, so a
 * session whose subagent trace was skipped once (or written later) comes back to a scan
 * rather than being retired by its parent's coverage (ADR-0008).
 */
async function eligibleSessions(
  sessions: SessionCandidate[],
  retired: ReadonlySet<string>,
): Promise<SessionCandidate[]> {
  const eligible: SessionCandidate[] = [];
  for (const session of sessions) {
    if (!retired.has(session.sessionId)) {
      eligible.push(session);
      continue;
    }
    const traceIds = await sessionTraceIds(session.path);
    if (traceIds.some(id => !retired.has(id))) eligible.push(session);
  }
  return eligible;
}

export interface StatusSummary {
  projectRoot: string;
  enabled: boolean;
  evaluatorPath: string;
  eligibleSessions: number;
  skippedSessions: number;
  proposed: number;
  approved: number;
  denied: number;
  lastEvaluation?: { at: string; outcome: string; reason?: string; verdict: string; lessons: number };
  promptChanges: number;
}

export async function collectStatus(
  paths: DistillPaths,
  config: DistillConfig,
  discovery: { sessions: SessionCandidate[]; skipped: { reason: string }[] },
): Promise<StatusSummary> {
  const retired = await retiredTraceSessionIds(paths);
  const eligible = await eligibleSessions(discovery.sessions, retired);
  const lessons = await listLessons(paths);
  const ledger = await readLedger(paths);
  const promptSha256 = await hashFile(paths.evaluatorPath);
  const evaluations = ledger.filter(record => record.kind === "evaluation");
  const last = evaluations[evaluations.length - 1];

  return {
    projectRoot: paths.projectRoot,
    enabled: config.enabled,
    evaluatorPath: paths.evaluatorPath,
    eligibleSessions: eligible.length,
    skippedSessions: discovery.skipped.length,
    proposed: lessons.filter(lesson => lesson.state === "proposed").length,
    approved: lessons.filter(lesson => lesson.state === "approved").length,
    denied: lessons.filter(lesson => lesson.state === "denied").length,
    ...(last && last.kind === "evaluation"
      ? {
          lastEvaluation: {
            at: last.at,
            // The operator-facing outcome: an empty run reads as empty, not as a plain failure.
            outcome: last.outcome === "lessons" ? "lessons" : last.reason === EMPTY_REASON ? "empty" : "failed",
            ...(last.reason === undefined ? {} : { reason: last.reason }),
            verdict: last.verdict,
            lessons: last.lessonIds.length,
          },
        }
      : {}),
    promptChanges:
      promptSha256 === undefined
        ? 0
        : evaluations.filter(record => record.kind === "evaluation" && record.promptSha256 !== promptSha256).length,
  };
}

export function renderStatus(summary: StatusSummary, scan?: string): string {
  const lines = [
    `distill — ${summary.enabled ? "enabled" : "disabled"} in ${summary.projectRoot}`,
    `evaluator prompt: ${path.relative(summary.projectRoot, summary.evaluatorPath)}`,
    `sessions eligible for a scan: ${summary.eligibleSessions}${summary.skippedSessions > 0 ? ` (${summary.skippedSessions} skipped)` : ""}`,
    ...(scan === undefined ? [] : [scan]),
    `lessons: ${summary.proposed} proposed, ${summary.approved} approved, ${summary.denied} denied`,
  ];
  if (summary.lastEvaluation) {
    const last = summary.lastEvaluation;
    const detail = last.lessons > 0 ? ` (${last.lessons} lesson(s))` : last.reason && last.reason !== EMPTY_REASON ? ` (${last.reason})` : "";
    lines.push(`last evaluation: ${last.at} → ${last.outcome}${detail}${last.verdict ? ` — ${last.verdict}` : ""}`);
  } else {
    lines.push("last evaluation: none yet");
  }
  if (summary.promptChanges > 0) {
    lines.push(`${summary.promptChanges} evaluation(s) ran under an earlier evaluator.md; nothing re-runs on a prompt edit.`);
  }
  if (summary.proposed > 0) lines.push("run /distill review to decide what to keep");
  return lines.join("\n");
}

async function runStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, paths: DistillPaths): Promise<void> {
  const config = await readConfig(paths);
  if (!config) {
    notify(ctx, "This project is not active: no .omp/distill/config.yaml yet. Run /distill setup.", "info");
    return;
  }
  const discovery = await listProjectSessions({
    cwd: paths.projectRoot,
    agentDir: pi.pi.getAgentDir(),
    sessionDir: ctx.sessionManager.getSessionDir(),
  });
  const job = await readScanJob(paths);
  const scan = describeScanJob(job, {
    running: await scanLockHeld(paths),
    pidAlive: job?.pid !== undefined && processAlive(job.pid),
  });
  notify(ctx, renderStatus(await collectStatus(paths, config, discovery), scan), "info");
}

async function runScan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: DistillPaths,
  flags: DistillFlags,
): Promise<void> {
  const config = await readConfig(paths);
  if (!config) {
    notify(ctx, "This project is not active: no .omp/distill/config.yaml yet. Run /distill setup.", "error");
    return;
  }
  if (!config.enabled) {
    notify(ctx, "distill is disabled in this project; /distill enable turns it back on.", "error");
    return;
  }

  const evaluator = await readEvaluatorPrompt(paths);
  if (!evaluator) {
    notify(ctx, `No evaluator prompt at ${paths.evaluatorPath}; run /distill setup.`, "error");
    return;
  }

  const discovery = await listProjectSessions({
    cwd: paths.projectRoot,
    agentDir: pi.pi.getAgentDir(),
    sessionDir: ctx.sessionManager.getSessionDir(),
  });
  const retired = await retiredTraceSessionIds(paths);
  const eligible = await eligibleSessions(discovery.sessions, retired);
  if (eligible.length === 0) {
    notify(ctx, `No unevaluated sessions for this project${discovery.skipped.length > 0 ? ` (${discovery.skipped.length} skipped)` : ""}.`, "info");
    return;
  }

  const selection = await selectSessions(ctx, eligible, flags, config);
  if (!selection) return;

  // Resolve the model here too: a bad `model:` key should fail before a daemon is started, not
  // inside a process whose output nobody is reading yet.
  const model = resolveModel(ctx, config);
  if (model instanceof Error) {
    notify(ctx, model.message, "error");
    return;
  }

  // A dry run sends nothing, records nothing and needs no daemon: it prints what a scan would send.
  if (flags.dryRun) {
    for (const session of selection) {
      await scanOne(pi, ctx, paths, config, evaluator, session, flags, model, new AbortController().signal, retired);
    }
    return;
  }

  // The lock is held for a scan's whole life by the runner; probing it here only refuses a second
  // scan early, with a message the operator can act on.
  const probe = await acquireScanLock(paths, { retries: 1 });
  if (!probe) {
    notify(ctx, "A scan is already running in this project — /distill status shows it.", "error");
    return;
  }
  probe.release();
  // A fresh scan never inherits a cancel request aimed at the last one.
  await clearCancelRequest(paths);

  const job = buildScanJob(selection);
  const started = await startScanJob(paths, job);
  if (!started.ok) {
    notify(
      ctx,
      `No background scan here (${started.reason}), so it runs in this session — closing OMP would end it.`,
      "warning",
    );
    await runScanJob(pi, ctx, paths);
    return;
  }
  notify(
    ctx,
    `Scan started in the background over ${job.sessions.length} session(s)${started.pid === undefined ? "" : ` (pid ${started.pid})`} — /distill status shows it, /distill cancel stops it. It keeps running if you close OMP.`,
    "info",
  );
}

/**
 * The runner: everything it needs is on disk, so the process that started it is irrelevant — which
 * is the point. In the daemon's own process this is the whole scan; when no daemon can be started
 * it is the same scan inside the operator's session, and `/distill status` says which.
 */
async function runScanJob(pi: ExtensionAPI, ctx: ExtensionCommandContext, paths: DistillPaths): Promise<void> {
  const job = await readScanJob(paths);
  if (job === undefined) {
    notify(ctx, `No scan journal at ${path.relative(paths.projectRoot, scanJobPath(paths))}; nothing to run.`, "error");
    return;
  }

  const config = await readConfig(paths);
  if (!config?.enabled) {
    await finishScanJob(paths, job, "failed", "the project is not active, or distill is disabled");
    notify(ctx, "The project is not active, or distill is disabled; the scan cannot run.", "error");
    return;
  }
  const evaluator = await readEvaluatorPrompt(paths);
  if (!evaluator) {
    await finishScanJob(paths, job, "failed", `no evaluator prompt at ${paths.evaluatorPath}`);
    notify(ctx, `No evaluator prompt at ${paths.evaluatorPath}; run /distill setup.`, "error");
    return;
  }
  const model = resolveModel(ctx, config);
  if (model instanceof Error) {
    await finishScanJob(paths, job, "failed", model.message);
    notify(ctx, model.message, "error");
    return;
  }

  const lock = await acquireScanLock(paths);
  if (!lock) {
    notify(ctx, "Another scan holds this project's lock; this runner exits without touching it.", "info");
    return;
  }

  const headless: DistillFlags = { dryRun: false, yes: false };
  try {
    job.status = "running";
    job.pid = process.pid;
    await writeScanJob(paths, job);

    const cancellation = new AbortController();
    const watcher = setInterval(() => {
      void fileExists(cancelRequestPath(paths)).then(pending => {
        if (pending) cancellation.abort();
      });
    }, 500);

    try {
      const retired = await retiredTraceSessionIds(paths);

      for (const entry of job.sessions) {
        if (cancellation.signal.aborted) break;
        // The journal carries the session — id, path, title, start time — so the runner reads its
        // own handoff instead of asking the store again under its own environment.
        entry.status = "running";
        await writeScanJob(paths, job);

        const outcome = await scanOne(pi, ctx, paths, config, evaluator, entry, headless, model, cancellation.signal, retired);
        if (cancellation.signal.aborted) {
          // A cancelled session is not a covered one. Its ledger row already says the run failed, so
          // its traces stay eligible — the journal has to say the same, or the count reads as work
          // that was done.
          entry.status = "pending";
          entry.reason = "cancelled before it finished";
          delete entry.lessons;
          delete entry.verdict;
          await writeScanJob(paths, job);
          break;
        }
        entry.status = outcome.failed === true ? "failed" : "done";
        entry.lessons = outcome.lessons;
        if (outcome.verdict !== undefined) entry.verdict = outcome.verdict;
        if (outcome.reason !== undefined) entry.reason = outcome.reason;
        job.lessons += outcome.lessons;
        if (outcome.failed === true) job.errors.push(`${entry.sessionId}: ${outcome.reason ?? "failed"}`);
        await writeScanJob(paths, job);
      }
      job.status = cancellation.signal.aborted ? "cancelled" : "finished";
    } finally {
      clearInterval(watcher);
      job.endedAt = new Date().toISOString();
      await writeScanJob(paths, job);
    }
  } finally {
    lock.release();
  }
}

/** Existence, not identity: used only for the seconds between a spawn and the lock it takes. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A runner that cannot start at all still has to leave the journal honest. */
async function finishScanJob(
  paths: DistillPaths,
  job: ScanJob,
  status: "failed" | "cancelled" | "finished",
  reason: string,
): Promise<void> {
  job.status = status;
  job.errors.push(reason);
  job.endedAt = new Date().toISOString();
  await writeScanJob(paths, job);
}

/** What one session's scan came to; the runner journals it and the daemon's log carries the words. */
interface ScanOutcome {
  lessons: number;
  verdict?: string;
  reason?: string;
  failed?: boolean;
}

async function scanOne(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  paths: DistillPaths,
  config: DistillConfig,
  evaluator: { text: string; sha256: string },
  session: ScanTarget,
  flags: DistillFlags,
  model: ResolvedModel,
  signal: AbortSignal,
  retired: ReadonlySet<string>,
): Promise<ScanOutcome> {
  const loaded = await loadTraceBundle({ sessionFile: session.path, projectRoot: paths.projectRoot });
  if (!loaded.ok) {
    await appendLedger(
      paths,
      evaluationRecord({
        sessionId: session.sessionId,
        sessionFile: session.path,
        traceSessionIds: [session.sessionId],
        outcome: "failed",
        reason: loaded.reason,
        promptSha256: evaluator.sha256,
      }),
    );
    notify(ctx, `${session.sessionId}: could not read the session — ${loaded.reason}`, "error");
    return { lessons: 0, reason: loaded.reason, failed: true };
  }

  // Traces an earlier evaluation already covered are not re-sent: a retry pays only for what
  // is still open, which is what per-trace retirement means.
  const covered = loaded.bundle.traces.filter(trace => retired.has(trace.sessionId)).length;
  const pending: TraceBundle = { ...loaded.bundle, traces: loaded.bundle.traces.filter(trace => !retired.has(trace.sessionId)) };
  if (pending.traces.length === 0) {
    notify(ctx, `${session.sessionId}: every trace is already evaluated.`, "info");
    return { lessons: 0, reason: "every trace is already evaluated" };
  }

  const renderOptions = { includeThinking: config.include_thinking };
  const payload = renderInventory(pending, renderOptions);

  if (flags.dryRun) {
    // The dry run prints exactly what a scan would send: the inventory is the whole payload.
    showPayload(ctx, payload);
    return { lessons: 0, reason: "dry run" };
  }

  notify(
    ctx,
    `Evaluating ${describeSession(session)} (${pending.traces.length} trace(s)${covered > 0 ? `, ${covered} already evaluated` : ""}) — this can take a while.`,
    "info",
  );

  const run = await runEvaluation({
    sdk: pi.pi,
    paths,
    agentDir: pi.pi.getAgentDir(),
    config,
    bundle: pending,
    payload,
    evaluatorPrompt: evaluator.text,
    modelRegistry: ctx.modelRegistry,
    ...(model.model === undefined ? {} : { model: model.model }),
    signal,
  });

  const saved =
    run.status === "lessons"
      ? await saveProposals(paths, run.proposals, {
          sessionId: session.sessionId,
          traceSessionIds: run.traceSessionIds,
          contractVersion: ANSWER_CONTRACT_VERSION,
          promptSha256: evaluator.sha256,
          ...(model.spec === undefined ? {} : { model: model.spec }),
        })
      : { created: [], duplicates: [] };

  await appendLedger(
    paths,
    evaluationRecord({
      sessionId: session.sessionId,
      sessionFile: session.path,
      traceSessionIds: run.traceSessionIds,
      outcome: run.status,
      ...(run.reason === undefined ? {} : { reason: run.reason }),
      verdict: run.verdict,
      lessonIds: saved.created.map(lesson => lesson.id),
      ...(model.spec === undefined ? {} : { model: model.spec }),
      promptSha256: evaluator.sha256,
      reads: run.reads,
    }),
  );

  const warnings = loaded.warnings.length > 0 ? ` (${loaded.warnings.length} subagent trace(s) skipped)` : "";
  if (run.status === "failed") {
    const dump = await writeFailureDump(paths, session, run.reason ?? "unknown", payload, run.reads);
    notify(
      ctx,
      `${session.sessionId}: the evaluation failed — ${run.reason} (${path.relative(paths.projectRoot, dump)})${warnings}. Its traces stay eligible for a retry.`,
      "error",
    );
    return { lessons: 0, reason: run.reason ?? "failed", failed: true };
  }
  if (saved.created.length === 0) {
    notify(ctx, `${session.sessionId}: nothing worth keeping — ${run.verdict || "no verdict given"}${warnings}`, "info");
    return { lessons: 0, verdict: run.verdict };
  }
  notify(
    ctx,
    `${session.sessionId}: ${saved.created.length} lesson(s) proposed${saved.duplicates.length > 0 ? `, ${saved.duplicates.length} duplicate(s) ignored` : ""}${warnings} — ${run.verdict}\nRun /distill review to decide.`,
    "info",
  );
  return { lessons: saved.created.length, verdict: run.verdict };
}

async function runReviewCommand(ctx: ExtensionCommandContext, paths: DistillPaths): Promise<void> {
  const config = await readConfig(paths);
  if (!config) {
    notify(ctx, "This project is not active: no .omp/distill/config.yaml yet. Run /distill setup.", "error");
    return;
  }

  const proposed = await listLessons(paths, "proposed");
  if (proposed.length === 0) {
    notify(ctx, "No lessons await review.", "info");
    return;
  }
  if (ctx.mode !== "tui") {
    notify(ctx, `/distill review needs the terminal; ${proposed.length} lesson(s) await in .omp/distill/lessons/.`, "error");
    return;
  }

  const proposedIds = new Set(proposed.map(lesson => lesson.id));
  const entries: ReviewEntry[] = [];
  for (const lesson of proposed) entries.push(await reviewEntry(paths, lesson));

  const outcome = await runReview(ctx, entries, {
    replan: (lesson: StoredLesson) => replanLesson(paths, lesson),
    accept: async lesson => {
      try {
        const plan = await planWrite(paths, lesson);
        const written = await applyWrite(paths, plan);
        await decideLesson(paths, lesson.id, {
          state: "approved",
          written: written.written.map(file => path.relative(paths.projectRoot, file)),
        });
        return undefined;
      } catch (error) {
        return messageOf(error);
      }
    },
    deny: async (lesson, reason) => {
      try {
        await decideLesson(paths, lesson.id, { state: "denied", ...(reason === undefined ? {} : { reason }) });
        return undefined;
      } catch (error) {
        return messageOf(error);
      }
    },
  });

  if (!outcome) return;

  // Counted from the store, not from the window's outcome: a decision still being written when
  // the operator quits must not read as "nothing decided".
  const decided = await listLessons(paths);
  const touched = decided.filter(lesson => proposedIds.has(lesson.id));
  const approved = touched.filter(lesson => lesson.state === "approved").length;
  const denied = touched.filter(lesson => lesson.state === "denied").length;
  if (approved === 0 && denied === 0) {
    notify(ctx, "Review closed; nothing decided.", "info");
    return;
  }
  notify(
    ctx,
    `Review closed: ${approved} approved, ${denied} denied. Approved lessons are live in the project's skill and agent roots from the next session.`,
    "info",
  );
}

async function reviewEntry(paths: DistillPaths, lesson: StoredLesson): Promise<ReviewEntry> {
  try {
    const plan = await planWrite(paths, lesson);
    return { lesson, changes: await planFileChanges(paths, plan.writes) };
  } catch (error) {
    return { lesson, blocked: messageOf(error) };
  }
}

/** What a lesson would change, recomputed: a decision moves the file the next lesson appends to. */
async function replanLesson(paths: DistillPaths, lesson: StoredLesson): Promise<FileChange[]> {
  const plan = await planWrite(paths, lesson);
  return await planFileChanges(paths, plan.writes);
}

/** Stops a running scan: the runner first, the broker's hammer only if it will not go. */
async function runCancel(ctx: ExtensionCommandContext, paths: DistillPaths): Promise<void> {
  const outcome = await cancelScanJob(paths);
  if (outcome === "idle") {
    notify(ctx, "No scan is running in this project.", "info");
    return;
  }
  if (outcome === "unreachable") {
    notify(ctx, "Could not reach the scan's supervisor, so nothing was asked of it — `omp ps` shows it if it is still there.", "warning");
    return;
  }
  notify(
    ctx,
    outcome === "cancelled"
      ? "The scan stopped; /distill status has what it managed to record."
      : "The scan would not stop in the grace period, so it was killed — the evaluation in flight is lost, and everything it already recorded stands.",
    "info",
  );
}

async function runPurge(ctx: ExtensionCommandContext, paths: DistillPaths, flags: DistillFlags): Promise<void> {
  const config = await readConfig(paths);
  if (!config) {
    notify(ctx, "This project is not active: no .omp/distill/config.yaml yet.", "info");
    return;
  }

  const confirmed =
    flags.yes ||
    (ctx.hasUI && ctx.mode === "tui"
      ? await ctx.ui.confirm(
          "Purge distill's records?",
          "This deletes this project's lessons, decision ledger and failure dumps, and re-opens every session for a later scan. It never touches omp's own session files, and it does not unwrite the skills or agent prompts an approved lesson was already written into.",
        )
      : false);

  if (!confirmed) {
    notify(ctx, "Purge cancelled. Pass --yes to confirm in a session without a dialog.", "info");
    return;
  }

  await fs.mkdir(paths.tmpDir, { recursive: true });
  await Bun.write(cancelRequestPath(paths), new Date().toISOString());
  const lock = await acquireScanLock(paths, { retries: 60, retryDelayMs: 500 });
  if (!lock) {
    await fs.rm(cancelRequestPath(paths), { force: true });
    notify(ctx, "A scan is still running and did not stop in time; run /distill purge again.", "error");
    return;
  }
  try {
    const result = await purge(paths);
    const lines = [
      `Purged ${result.lessonsRemoved} lesson(s) and ${result.decisionsRemoved} ledger row(s); every session is eligible again.`,
    ];
    lines.push(
      result.leftAlone.length === 0
        ? "No files had been written from approved lessons."
        : `Left alone (purge does not unwrite files): ${result.leftAlone.join(", ")}`,
    );
    notify(ctx, lines.join("\n"), "info");
  } finally {
    lock.release();
  }
}

interface ResolvedModel {
  spec?: string;
  model?: EvaluatorModel;
}

/**
 * Choosing the evaluator's model, by provider and then by model: the authenticated catalog
 * runs to hundreds of models across a dozen providers, so a flat list would bury everything
 * behind whichever provider the registry happens to order first. The session's provider leads,
 * Esc at either step keeps the session's own model, and only specs that resolve back to the
 * model they came from are offered — the config stores that string.
 */
async function pickModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const byProvider = new Map<string, Array<{ spec: string; name: string }>>();
  for (const candidate of ctx.models.list()) {
    const spec = specOf(candidate);
    if (spec === "") continue;
    const resolved = ctx.models.resolve(spec);
    if (!resolved || specOf(resolved) !== spec) continue;
    const rows = byProvider.get(candidate.provider) ?? [];
    if (rows.some(row => row.spec === spec)) continue;
    rows.push({ spec, name: typeof candidate.name === "string" && candidate.name !== candidate.id ? candidate.name : "" });
    byProvider.set(candidate.provider, rows);
  }

  const current = ctx.models.current()?.provider;
  const providers = [...byProvider.keys()].sort((left, right) =>
    left === current ? -1 : right === current ? 1 : 0,
  );
  if (providers.length === 0) return undefined;

  let provider = providers[0] ?? "";
  if (providers.length > 1) {
    const labels = new Map(
      providers.map(name => [
        `${name} — ${byProvider.get(name)?.length ?? 0} model${(byProvider.get(name)?.length ?? 0) === 1 ? "" : "s"}${name === current ? " (this session)" : ""}`,
        name,
      ]),
    );
    const chosen = await ctx.ui.select("Evaluator model — provider (Esc keeps this session's model)", [...labels.keys()]);
    if (chosen === undefined) return undefined;
    provider = labels.get(chosen) ?? provider;
  }

  const rows = byProvider.get(provider) ?? [];
  if (rows.length === 1) return rows[0]?.spec;
  const models = new Map(rows.map(row => [row.spec, row]));
  const chosen = await ctx.ui.select(
    `Evaluator model — ${provider} (Esc keeps this session's model)`,
    rows.map(row => (row.name === "" ? row.spec : { label: row.spec, description: row.name })),
  );
  if (chosen === undefined) return undefined;
  return models.get(chosen)?.spec;
}

/** No `model` in the config means the session's own model: the operator's authenticated choice. */
function resolveModel(ctx: ExtensionCommandContext, config: DistillConfig): ResolvedModel | Error {
  if (config.model) {
    const resolved = ctx.models.resolve(config.model);
    if (!resolved) return new Error(`Unknown evaluator model "${config.model}"; check the model/ key in .omp/distill/config.yaml.`);
    return { spec: specOf(resolved), model: resolved };
  }
  const current = ctx.model;
  return current ? { spec: specOf(current), model: current } : {};
}

/** The `provider/id` string the config stores and `ctx.models.resolve` reads back. */
function specOf(model: { provider?: string; id?: string }): string {
  const id = model.id ?? "";
  if (id === "") return "";
  return model.provider ? `${model.provider}/${id}` : id;
}

async function selectSessions(
  ctx: ExtensionCommandContext,
  eligible: SessionCandidate[],
  flags: DistillFlags,
  config: DistillConfig,
): Promise<SessionCandidate[] | undefined> {
  if (flags.session !== undefined) {
    const wanted = flags.session;
    const match = eligible.find(
      session => session.sessionId === wanted || session.sessionId.startsWith(wanted) || session.path === wanted,
    );
    if (!match) {
      notify(ctx, `No unevaluated session matches "${wanted}".`, "error");
      return undefined;
    }
    return [match];
  }

  // A terminal gets the chooser; a headless run evaluates the most recent sessions up to
  // the configured bound, so a scripted scan costs what it says it costs.
  const limit = flags.limit ?? (ctx.mode === "tui" ? undefined : config.scan_limit);
  if (limit === undefined) {
    const labels = new Map<string, SessionCandidate>();
    const options: string[] = [];
    for (const session of eligible.slice(0, 25)) {
      const label = `${describeSession(session)} · ${session.sessionId.slice(0, 8)}`;
      labels.set(label, session);
      options.push(label);
    }
    const chosen = await ctx.ui.select("Sessions to evaluate — Esc cancels", options);
    if (chosen === undefined) return undefined;
    const picked = labels.get(chosen);
    return picked ? [picked] : undefined;
  }
  return eligible.slice(0, limit);
}

function describeSession(session: { created: string; title: string }): string {
  const title = session.title.trim() === "" ? "(untitled)" : session.title.trim();
  return `${session.created.slice(0, 16).replace("T", " ")} ${title}`;
}

async function readEvaluatorPrompt(paths: DistillPaths): Promise<{ text: string; sha256: string } | undefined> {
  let text: string;
  try {
    text = await Bun.file(paths.evaluatorPath).text();
  } catch {
    return undefined;
  }
  return { text, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") };
}

async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    return new Bun.CryptoHasher("sha256").update(await Bun.file(filePath).text()).digest("hex");
  } catch {
    return undefined;
  }
}

const MAX_DUMPED_PAYLOAD_CHARS = 100_000;

/** The failure dump `tmp/` exists for: what the evaluator was sent when a run failed loudly. */
async function writeFailureDump(
  paths: DistillPaths,
  session: ScanTarget,
  reason: string,
  payload: string,
  reads: string[],
): Promise<string> {
  await fs.mkdir(paths.tmpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dumpPath = path.join(paths.tmpDir, `${stamp}_${session.sessionId.slice(0, 8)}.json`);
  const dump = {
    at: new Date().toISOString(),
    sessionId: session.sessionId,
    sessionFile: session.path,
    reason,
    payloadBytes: Buffer.byteLength(payload, "utf8"),
    payloadChars: payload.length,
    truncated: payload.length > MAX_DUMPED_PAYLOAD_CHARS,
    reads,
    payload: payload.slice(0, MAX_DUMPED_PAYLOAD_CHARS),
  };
  await Bun.write(dumpPath, `${JSON.stringify(dump, null, 2)}\n`);
  return dumpPath;
}

function showPayload(ctx: ExtensionCommandContext, payload: string): void {
  if (ctx.mode === "tui") {
    void ctx.ui.editor("distill payload — nothing was sent", payload);
    return;
  }
  if (ctx.mode === "print") process.stdout.write(`${payload}\n`);
}

/** The one mode-aware output path: TUI and RPC notify, print writes stdout, JSON stays silent. */
export function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  if (ctx.mode === "tui" || ctx.mode === "rpc") {
    ctx.ui.notify(message, type);
    return;
  }
  // Print mode's stdout is text; JSON mode's is the event stream, so it gets nothing.
  if (ctx.mode === "print") process.stdout.write(`${type === "error" ? "error: " : ""}${message}\n`);
}
