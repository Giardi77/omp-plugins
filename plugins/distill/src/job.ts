/**
 * A scan is a background process.
 *
 * `/distill scan` resolves what to evaluate, writes that list as a journal, and spawns a detached
 * `omp -p "/distill _job"` that outlives the OMP which started it. The runner takes the scan lock,
 * walks the journal, and updates it after every session.
 *
 * The host has a daemon broker that would do the spawning, and it was the first implementation —
 * until the installed layout proved it unreachable: from a marketplace-installed plugin the
 * `@oh-my-pi/pi-coding-agent/launch/client` subpath does not resolve and the package root does not
 * export it, the same wall ADR-0011 recorded for two other host subpaths. A detached spawn is
 * `Bun.spawn({ detached: true })` plus `unref()`, which is all the broker gave us here, so the
 * plugin owns those forty lines instead of a dependency that only works from the repo (ADR-0014).
 *
 * Division of truth: the **scan lock** says whether a scan is running — an OS lease, released when
 * its process dies, which is the one thing a pid file can never promise — and the journal says what
 * it has done. `/distill status` reads both.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { acquireFileLock, type FileLockHandle } from "@oh-my-pi/pi-utils";
import type { DistillPaths } from "./config";

let spawnerOverride: ScanSpawner | undefined;
/** How long `/distill cancel` lets the runner stop by itself before it is killed. */
export const CANCEL_GRACE_MS = 10_000;

export type ScanJobStatus = "starting" | "running" | "finished" | "failed" | "cancelled";
export type ScanSessionStatus = "pending" | "running" | "done" | "failed";

/**
 * What a scan needs to know about a session — carried in the journal rather than looked up again.
 * The runner boots in its own process, possibly minutes later, under its own environment: re-listing
 * the store there would make the handoff depend on both processes resolving the same agent directory,
 * and a store that disagrees by one directory reads as "the session is gone".
 */
export interface ScanTarget {
  sessionId: string;
  /** The session's transcript file, the same one the scan read its traces from. */
  path: string;
  title: string;
  /** The session's start time, as its header records it. */
  created: string;
}

export interface ScanJobSession extends ScanTarget {
  status: ScanSessionStatus;
  lessons?: number;
  verdict?: string;
  reason?: string;
}

export interface ScanJob {
  status: ScanJobStatus;
  startedAt: string;
  endedAt?: string;
  /** The runner's process: written by the spawn that started it, then by the runner itself, which
   * is the only pid a scan running inside the operator's session has. */
  pid?: number;
  sessions: ScanJobSession[];
  lessons: number;
  errors: string[];
}

export type ScanJobStart = { ok: true; pid?: number } | { ok: false; reason: string };
export type ScanCancelOutcome = "idle" | "cancelled" | "stopped" | "unreachable";

/** How the runner is started, so a test can watch the plan without spawning a process. */
export interface ScanSpawnPlan {
  command: string[];
  cwd: string;
  logPath: string;
}

export type ScanSpawner = (plan: ScanSpawnPlan) => Promise<{ pid?: number }>;

export function scanJobPath(paths: DistillPaths): string {
  return path.join(paths.tmpDir, "scan.json");
}

/** The runner polls for this while it scans; `/distill cancel` and `/distill purge` write it. */
export function cancelRequestPath(paths: DistillPaths): string {
  return path.join(paths.tmpDir, "scan.cancel");
}

/** What `/distill scan` hands the runner: the sessions it resolved, in the order to take them. */
export function buildScanJob(selection: readonly ScanTarget[], now = new Date()): ScanJob {
  return {
    status: "starting",
    startedAt: now.toISOString(),
    sessions: selection.map(session => ({
      sessionId: session.sessionId,
      path: session.path,
      title: session.title,
      created: session.created,
      status: "pending",
    })),
    lessons: 0,
    errors: [],
  };
}

export async function readScanJob(paths: DistillPaths): Promise<ScanJob | undefined> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(scanJobPath(paths)).text());
    return isScanJob(parsed) ? parsed : undefined;
  } catch {
    // No journal yet, or one a crash left half-written: `status` says what it can and no more.
    return undefined;
  }
}

/** Atomic: a reader never sees half a journal, and a crash never leaves one. */
export async function writeScanJob(paths: DistillPaths, job: ScanJob): Promise<void> {
  await fs.mkdir(paths.tmpDir, { recursive: true });
  const target = scanJobPath(paths);
  const temp = `${target}.${process.pid}.tmp`;
  await Bun.write(temp, `${JSON.stringify(job, null, 2)}\n`);
  await fs.rename(temp, target);
}

export async function requestScanCancel(paths: DistillPaths): Promise<void> {
  await fs.mkdir(paths.tmpDir, { recursive: true });
  await Bun.write(cancelRequestPath(paths), `${new Date().toISOString()}\n`);
}

export async function clearCancelRequest(paths: DistillPaths): Promise<void> {
  await fs.rm(cancelRequestPath(paths), { force: true });
}

/**
 * The runner's log: its notices, and whatever the provider says when a run fails. One name, not one
 * per scan — a scan at a time means the current log is the last scan's, and a path anyone can find.
 */
export function scanLogPath(paths: DistillPaths): string {
  return path.join(paths.tmpDir, "scan.log");
}

export async function startScanJob(paths: DistillPaths, job: ScanJob): Promise<ScanJobStart> {
  // The journal is written first: the runner reads it, and the fallback below runs it in this
  // process — either way `/distill status` has something true to read within the same turn.
  await writeScanJob(paths, job);
  const runtime = Bun.which("omp");
  if (!runtime) return { ok: false, reason: "the omp executable is not on PATH" };
  const logPath = scanLogPath(paths);
  try {
    // A command-only print run: no TUI, no session, and it exits when the scan does. `--no-session`
    // is load-bearing rather than tidy: without it the host attaches the run to the project's newest
    // session, and `omp -p` appends a `session_exit` record to it on the way out — the store is
    // read-only input (ADR-0006), and a scan would be the one thing that writes to it.
    const spawned = await (spawnerOverride ?? spawnDetached)({
      command: [runtime, "-p", "--no-session", "/distill _job"],
      cwd: paths.projectRoot,
      logPath,
    });
    if (spawned.pid !== undefined) {
      // The runner overwrites this with its own pid when it takes the lock; written here so a spawn
      // that dies before the lock is distinguishable from one that never happened.
      job.pid = spawned.pid;
      await writeScanJob(paths, job);
    }
    return spawned.pid === undefined ? { ok: true } : { ok: true, pid: spawned.pid };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Detached and unref'd: the child gets its own process group and outlives this process. */
async function spawnDetached(plan: ScanSpawnPlan): Promise<{ pid?: number }> {
  const log = await fs.open(plan.logPath, "w");
  try {
    const child = Bun.spawn(plan.command, {
      cwd: plan.cwd,
      stdin: "ignore",
      stdout: log.fd,
      stderr: log.fd,
      detached: true,
    });
    child.unref();
    return child.pid === undefined ? {} : { pid: child.pid };
  } finally {
    // The child holds its own copy of the descriptor.
    await log.close();
  }
}

/**
 * Whether a scan holds the project's lock, asked the only way that cannot lie: acquire it, and give
 * it straight back. A held lock means a scan is running — a pid file would answer the same question
 * with a stale pid or a reused one, and the OS drops this lease when its holder dies (ADR-0014).
 */
export async function scanLockHeld(paths: DistillPaths): Promise<boolean> {
  const lock = await acquireScanLock(paths, { retries: 1 });
  if (lock === undefined) return true;
  lock.release();
  return false;
}

/** One scan at a time, across processes: the scan lock is distinct from the store lock. */
export async function acquireScanLock(
  paths: DistillPaths,
  options: { retries?: number; retryDelayMs?: number } = {},
): Promise<FileLockHandle | undefined> {
  await fs.mkdir(paths.locksDir, { recursive: true });
  try {
    return await acquireFileLock(path.join(paths.locksDir, "scan"), { retries: 1, ...options });
  } catch {
    return undefined;
  }
}

async function waitForLockFree(paths: DistillPaths, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await scanLockHeld(paths))) return true;
    await scheduler.wait(250);
  }
  return !(await scanLockHeld(paths));
}

export async function cancelScanJob(paths: DistillPaths, graceMs = CANCEL_GRACE_MS): Promise<ScanCancelOutcome> {
  if (!(await scanLockHeld(paths))) return "idle";
  // Graceful first: the runner notices within a poll interval, aborts the evaluation in flight and
  // keeps everything it has already recorded.
  await requestScanCancel(paths);
  if (await waitForLockFree(paths, graceMs)) return "cancelled";

  // It would not go. The pid is the runner's own, written by the spawn that started it, and the
  // lock is still held by *something*, so this kills the process holding it rather than a stranger.
  const job = await readScanJob(paths);
  if (job?.pid === undefined) return "unreachable";
  try {
    process.kill(job.pid, "SIGTERM");
  } catch {
    return "unreachable";
  }
  return (await waitForLockFree(paths, 5_000)) ? "stopped" : "unreachable";
}

export interface ScanJobState {
  /** Whether the scan lock is held — the truth about liveness, and the only one. */
  running: boolean;
  /** Whether the pid the spawn recorded is still alive: the seconds before the runner locks. */
  pidAlive: boolean;
}

/**
 * The one line `/distill status` adds about scanning, in every state it can be in: running,
 * starting up (spawned, lock not yet taken), interrupted (the journal says running and the lock is
 * free), or over — finished, cancelled or failed, with a failed session's reason on the line rather
 * than hidden (ADR-0008 keeps technical faults visible).
 */
export function describeScanJob(job: ScanJob | undefined, state: ScanJobState): string | undefined {
  const done = job?.sessions.filter(session => session.status === "done" || session.status === "failed").length ?? 0;
  const total = job?.sessions.length ?? 0;
  const counted = `${done} of ${total} session(s)`;
  // A session that failed is not a session that taught nothing: ADR-0008 keeps technical faults
  // visible, and the line would otherwise read like an empty, healthy scan.
  const failed = job?.sessions.filter(session => session.status === "failed").length ?? 0;
  const firstReason = job?.sessions.find(session => session.status === "failed")?.reason ?? job?.errors[0];
  const failures = failed === 0 ? "" : `, ${failed} failed${firstReason === undefined ? "" : `: ${firstReason}`}`;

  if (state.running && job !== undefined) {
    const current = job.sessions.find(session => session.status === "running");
    const at = ` — session ${Math.min(done + 1, Math.max(total, 1))} of ${total}${current === undefined ? "" : ` (${sessionLabel(current)})`}`;
    return `scan: running since ${stamp(job.startedAt)}${at}; ${job.lessons} lesson(s) so far${job.pid === undefined ? "" : ` (pid ${job.pid})`}`;
  }

  if (job === undefined) {
    // No journal: nothing ever ran here, or the lock is held by a scan whose journal went missing
    // underneath it (a purge during a scan, say).
    return state.running ? "scan: running, but it left no journal, so its progress is unknown" : undefined;
  }

  // Spawned, journal written, lock not taken yet: this is the second or two of booting.
  if ((job.status === "starting" || job.status === "running") && state.pidAlive) {
    return `scan: starting up${job.pid === undefined ? "" : ` (pid ${job.pid})`} — the runner is taking the lock`;
  }

  const over = job.endedAt === undefined ? "" : ` at ${stamp(job.endedAt)}`;
  if (job.status === "cancelled") return `scan: cancelled${over} after ${counted}${failures} — the rest stay eligible`;
  if (job.status === "finished") {
    return `scan: finished${over} — ${counted}, ${job.lessons} lesson(s) proposed${failures}`;
  }
  if (job.status === "failed") {
    return `scan: failed${over} after ${counted}${failures} — ${job.errors[0] ?? "no reason given"}`;
  }
  // The journal says it is running and the lock is free with no live pid: the process that held it
  // is gone. Whatever it recorded stands; the traces it never reached stay eligible.
  return `scan: interrupted${over} after ${counted}${failures} — nothing holds the scan lock; the rest stay eligible`;
}

function sessionLabel(session: ScanJobSession): string {
  const title = session.title.trim() === "" ? "(untitled)" : session.title.trim();
  return `${title} · ${session.sessionId.slice(0, 8)}`;
}

/** ISO to the same "2026-09-24 19:12" shape the rest of status uses. */
function stamp(at: string | undefined): string {
  return at === undefined ? "an unknown time" : at.slice(0, 16).replace("T", " ");
}

function isScanJob(value: unknown): value is ScanJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Partial<ScanJob>;
  if (typeof job.status !== "string" || typeof job.startedAt !== "string" || typeof job.lessons !== "number") return false;
  if (!Array.isArray(job.sessions) || !Array.isArray(job.errors)) return false;
  return job.sessions.every(session => {
    const entry = session as Partial<ScanJobSession>;
    return (
      typeof entry.sessionId === "string" &&
      typeof entry.path === "string" &&
      typeof entry.title === "string" &&
      typeof entry.created === "string" &&
      typeof entry.status === "string"
    );
  });
}

/**
 * Test-only: the spawner the command would otherwise use. Tests pin the launch plan without leaving
 * an `omp` process behind on the machine running the suite.
 */
export function __setScanSpawnForTests(spawner: ScanSpawner | undefined): void {
  spawnerOverride = spawner;
}
