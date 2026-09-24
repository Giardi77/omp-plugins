/**
 * A scan is a background daemon.
 *
 * `/distill scan` resolves what to evaluate, writes that list as a journal, and hands it to the
 * host's own daemon broker (`@oh-my-pi/pi-coding-agent/launch/client`). The broker starts a
 * detached `omp -p "/distill _job"`, keeps it alive after the OMP that started it is gone, captures
 * its output, and lists it in `omp ps`. A pid file, a log file and a supervision loop of our own
 * would only re-implement the broker (ADR-0014).
 *
 * Division of truth: the broker owns liveness (is the runner still there), the journal
 * (`tmp/scan.json`, written by the runner) owns progress — which session it is on, how many lessons
 * it has proposed. `/distill status` reads both.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DistillPaths } from "./config";

export const SCAN_DAEMON_NAME = "distill-scan";
/** How long `/distill cancel` lets the runner stop by itself before the broker kills it. */
export const CANCEL_GRACE_MS = 10_000;

/** Daemon lifecycle states the broker reports (see pi-tui's launch types). */
export type DaemonState = "starting" | "running" | "ready" | "restarting" | "stopping" | "exited" | "failed";

export interface ScanDaemonRecord {
  name: string;
  state: DaemonState | string;
  pid?: number;
  exitCode?: number;
  exitReason?: string;
  outputBytes?: number;
}

/** The immutable launch spec the host's broker starts (its `DaemonSpec`). */
export interface ScanDaemonSpec {
  name: string;
  application: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  pty: boolean;
  restart: string;
  persist: boolean;
  detached: boolean;
}

export type ScanJobStatus = "starting" | "running" | "finished" | "failed" | "cancelled";
export type ScanSessionStatus = "pending" | "running" | "done" | "failed";

export interface ScanJobSession {
  sessionId: string;
  title: string;
  status: ScanSessionStatus;
  lessons?: number;
  verdict?: string;
  reason?: string;
}

export interface ScanJob {
  status: ScanJobStatus;
  startedAt: string;
  endedAt?: string;
  /** The runner's process, written by the runner itself: the daemon path is covered by the broker's
   * snapshot, and this is what keeps an in-process scan from reading as "interrupted". */
  pid?: number;
  sessions: ScanJobSession[];
  lessons: number;
  errors: string[];
}

export type ScanJobStart = { ok: true; pid?: number } | { ok: false; reason: string };
export type ScanCancelOutcome = "idle" | "cancelled" | "stopped" | "unreachable";

/** The four broker calls this plugin makes, so the wire protocol stays in one adapter. */
export interface ScanBroker {
  start(spec: ScanDaemonSpec): Promise<{ pid?: number }>;
  list(): Promise<ScanDaemonRecord[]>;
  waitForExit(name: string, timeoutMs: number): Promise<boolean>;
  stop(name: string, timeoutMs: number): Promise<boolean>;
}

export function scanJobPath(paths: DistillPaths): string {
  return path.join(paths.tmpDir, "scan.json");
}

/** The runner polls for this while it scans; `/distill cancel` and `/distill purge` write it. */
export function cancelRequestPath(paths: DistillPaths): string {
  return path.join(paths.tmpDir, "scan.cancel");
}

/** What `/distill scan` hands the runner: the sessions it resolved, in the order to take them. */
export function buildScanJob(selection: ReadonlyArray<{ sessionId: string; title: string }>, now = new Date()): ScanJob {
  return {
    status: "starting",
    startedAt: now.toISOString(),
    sessions: selection.map(session => ({ sessionId: session.sessionId, title: session.title, status: "pending" })),
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

export function daemonAlive(daemon: ScanDaemonRecord | undefined): boolean {
  return daemon !== undefined && daemon.state !== "exited" && daemon.state !== "failed";
}

export async function startScanJob(paths: DistillPaths, job: ScanJob): Promise<ScanJobStart> {
  // The journal is written first: the runner reads it, and the fallback below runs it in this
  // process — either way `/distill status` has something true to read within the same turn.
  await writeScanJob(paths, job);
  const runtime = Bun.which("omp");
  if (!runtime) return { ok: false, reason: "the omp executable is not on PATH" };
  const broker = await scanBroker(paths);
  if (!broker) return { ok: false, reason: "the host's daemon broker is unavailable in this session" };
  try {
    const started = await broker.start({
      name: SCAN_DAEMON_NAME,
      application: runtime,
      // A command-only print run: no TUI, no session in the store, and it exits when the scan does.
      args: ["-p", "/distill _job"],
      env: {},
      cwd: paths.projectRoot,
      pty: false,
      restart: "no",
      persist: true,
      detached: true,
    });
    return started.pid === undefined ? { ok: true } : { ok: true, pid: started.pid };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function readScanDaemon(paths: DistillPaths): Promise<ScanDaemonRecord | undefined> {
  const broker = await scanBroker(paths);
  if (!broker) return undefined;
  try {
    return (await broker.list()).find(record => record.name === SCAN_DAEMON_NAME);
  } catch {
    // A broker that cannot be reached is not the status command's problem to report twice.
    return undefined;
  }
}

export async function cancelScanJob(paths: DistillPaths, graceMs = CANCEL_GRACE_MS): Promise<ScanCancelOutcome> {
  const daemon = await readScanDaemon(paths);
  const job = await readScanJob(paths);
  if (daemon !== undefined && !daemonAlive(daemon)) return "idle";
  // No daemon and no running journal: nothing to cancel, and nothing to write.
  if (daemon === undefined && (job === undefined || (job.status !== "running" && job.status !== "starting"))) {
    return "idle";
  }

  // Graceful first: the runner notices within a poll interval, aborts the evaluation in flight and
  // keeps everything it has already recorded. A scan running in the operator's own session (the
  // fallback, and the daemon's own process) stops exactly the same way.
  await requestScanCancel(paths);
  const broker = daemon === undefined ? undefined : await scanBroker(paths);
  if (broker === undefined) return "cancelled";
  try {
    if (await broker.waitForExit(SCAN_DAEMON_NAME, graceMs)) return "cancelled";
    return (await broker.stop(SCAN_DAEMON_NAME, 5_000)) ? "stopped" : "unreachable";
  } catch {
    return "cancelled";
  }
}

/**
 * The one line `/distill status` adds about scanning. Both halves are optional: the journal can
 * exist without a broker (an in-process scan) and a daemon record can exist without a journal
 * (a runner that died before it published one), and each case still has something honest to say.
 */
export function describeScanJob(job: ScanJob | undefined, daemon: ScanDaemonRecord | undefined): string | undefined {
  if (job === undefined && daemon === undefined) return undefined;
  const done = job?.sessions.filter(session => session.status === "done" || session.status === "failed").length ?? 0;
  const total = job?.sessions.length ?? 0;
  const counted = `${done} of ${total} session(s)`;
  // A scan with no daemon is either the fallback (running in the operator's own session, which
  // writes its pid to the journal) or one whose process died. A "running" journal without a pid is
  // impossible from a live runner — the runner writes both together — so it reads as gone.
  const running = job !== undefined && job.status === "running" && job.pid !== undefined && pidAlive(job.pid);

  if (daemonAlive(daemon) || running) {
    const current = job?.sessions.find(session => session.status === "running");
    const at = job === undefined ? "" : ` — session ${Math.min(done + 1, Math.max(total, 1))} of ${total}${current === undefined ? "" : ` (${sessionLabel(current)})`}`;
    const pid = daemon?.pid ?? job?.pid;
    return `scan: running since ${stamp(job?.startedAt)}${at}; ${job?.lessons ?? 0} lesson(s) so far${pid === undefined ? "" : ` (pid ${pid})`}`;
  }

  if (job === undefined) {
    return `scan: ${daemon?.state ?? "unknown"}${daemon?.exitReason === undefined ? "" : ` (${daemon.exitReason})`} — no journal was left, so its progress is unknown`;
  }

  const over = job.endedAt === undefined ? "" : ` at ${stamp(job.endedAt)}`;
  if (job.status === "cancelled") return `scan: cancelled${over} after ${counted} — the rest stay eligible`;
  if (job.status === "finished") return `scan: finished${over} — ${counted}, ${job.lessons} lesson(s) proposed`;
  if (job.status === "failed") {
    return `scan: failed${over} after ${counted} — ${job.errors[0] ?? daemon?.exitReason ?? "no reason given"}`;
  }
  // The journal says running and the runner is gone: the OMP that owned the daemon died, or it was
  // killed. Whatever it recorded stands; the traces it never reached stay eligible.
  return `scan: interrupted${over} after ${counted} — its runner is gone (${daemon?.exitReason ?? "no daemon record"}); the rest stay eligible`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
    return typeof entry.sessionId === "string" && typeof entry.title === "string" && typeof entry.status === "string";
  });
}

function recordOf(value: unknown): ScanDaemonRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== "string" || typeof entry.state !== "string") return undefined;
  return {
    name: entry.name,
    state: entry.state,
    ...(typeof entry.pid === "number" ? { pid: entry.pid } : {}),
    ...(typeof entry.exitCode === "number" ? { exitCode: entry.exitCode } : {}),
    ...(typeof entry.exitReason === "string" ? { exitReason: entry.exitReason } : {}),
    ...(typeof entry.outputBytes === "number" ? { outputBytes: entry.outputBytes } : {}),
  };
}

/**
 * The host's broker, behind a package subpath a compiled host may not serve (ADR-0011): the import
 * is lazy, cached, and its absence degrades to running the scan in this process.
 */
let brokerLoader: Promise<ScanBroker | undefined> | undefined;
let brokerOverride: ScanBroker | undefined;

async function scanBroker(paths: DistillPaths): Promise<ScanBroker | undefined> {
  if (brokerOverride !== undefined) return brokerOverride;
  brokerLoader ??= (async (): Promise<ScanBroker | undefined> => {
    try {
      const module = (await import("@oh-my-pi/pi-coding-agent/launch/client")) as {
        daemonClientForProject?: (projectDir: string) => Promise<{ request: (operation: unknown) => Promise<unknown> }>;
      };
      if (typeof module.daemonClientForProject !== "function") return undefined;
      const client = await module.daemonClientForProject(paths.projectRoot);
      return {
        async start(spec) {
          const reply = recordOfReply(await client.request({ op: "start", spec, replace: true }));
          return reply.pid === undefined ? {} : { pid: reply.pid };
        },
        async list() {
          const reply = (await client.request({ op: "list" })) as { daemons?: unknown };
          const daemons = Array.isArray(reply.daemons) ? reply.daemons : [];
          const records: ScanDaemonRecord[] = [];
          for (const entry of daemons) {
            const record = recordOf(entry);
            if (record) records.push(record);
          }
          return records;
        },
        async waitForExit(name, timeoutMs) {
          const reply = (await client.request({ op: "wait", name, for: "exit", timeoutMs })) as { timedOut?: unknown };
          return reply.timedOut !== true;
        },
        async stop(name, timeoutMs) {
          const reply = (await client.request({ op: "stop", name, timeoutMs })) as { op?: unknown };
          return reply.op === "stop";
        },
      };
    } catch {
      return undefined;
    }
  })();
  try {
    return await brokerLoader;
  } catch {
    return undefined;
  }
}

function recordOfReply(value: unknown): ScanDaemonRecord {
  const daemon = (value as { daemon?: unknown } | undefined)?.daemon;
  return recordOf(daemon) ?? { name: SCAN_DAEMON_NAME, state: "starting" };
}

/**
 * Test-only: the broker these functions would otherwise reach. Tests pin the launch spec and the
 * status line without spawning a real broker in `~/.omp/run`.
 */
export function __setScanBrokerForTests(broker: ScanBroker | undefined): void {
  brokerOverride = broker;
}
