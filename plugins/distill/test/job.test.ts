import { afterEach, describe, expect, test } from "bun:test";
import { scheduler } from "node:timers/promises";
import { distillPaths } from "../src/config";
import {
  __setScanSpawnForTests,
  acquireScanLock,
  buildScanJob,
  cancelScanJob,
  cancelRequestPath,
  clearCancelRequest,
  describeScanJob,
  readScanJob,
  scanJobPath,
  startScanJob,
  writeScanJob,
  type ScanJobState,
  type ScanSpawnPlan,
  type ScanTarget,
} from "../src/job";
import { fileExists } from "../src/util";
import { makeTempDir } from "./fixtures";

async function paths() {
  const root = await makeTempDir("omp-distill-job-");
  const project = `${root}/project`;
  await Bun.write(`${project}/.keep`, "");
  const resolved = distillPaths(project);
  await Bun.write(`${resolved.tmpDir}/.keep`, "");
  return resolved;
}

function target(id: string, title: string): ScanTarget {
  return { sessionId: id, path: `/sessions/${id}.jsonl`, title, created: "2026-09-24T19:00:00.000Z" };
}

/** A scan holding its lock. The lock is the truth about liveness; the pid only covers the boots. */
function scanning(pidAlive = false): ScanJobState {
  return { running: true, pidAlive };
}

function idle(pidAlive = false): ScanJobState {
  return { running: false, pidAlive };
}

afterEach(() => {
  __setScanSpawnForTests(undefined);
});

describe("a scan's journal", () => {
  test("survives a round trip, and a foreign or half-written file reads as nothing", async () => {
    const distilled = await paths();
    const job = buildScanJob([target("aaaa1111-2222-7000-8000-000000000060", "retry helper")]);
    await writeScanJob(distilled, job);
    expect(await readScanJob(distilled)).toEqual(job);

    // A file a crash left half-written is not a journal, and status must not throw on it.
    await Bun.write(scanJobPath(distilled), '{"status":"running","sessions":[');
    expect(await readScanJob(distilled)).toBeUndefined();

    await Bun.write(scanJobPath(distilled), JSON.stringify({ status: "running" }));
    expect(await readScanJob(distilled)).toBeUndefined();

    // Nothing there at all is the normal state of a project nobody has scanned.
    await Bun.write(scanJobPath(distilled), "");
    expect(await readScanJob(distilled)).toBeUndefined();
  });

  test("a fresh scan starts from the sessions it was given, all pending", async () => {
    const job = buildScanJob([target("one", ""), target("two", "Two")]);
    expect(job.status).toBe("starting");
    expect(job.sessions.map(session => session.status)).toEqual(["pending", "pending"]);
    expect(job.sessions[1]?.title).toBe("Two");
    // The handoff is self-contained: the runner needs no store lookup to find the session.
    expect(job.sessions[1]?.path).toBe("/sessions/two.jsonl");
    expect(job.sessions[1]?.created).toBe("2026-09-24T19:00:00.000Z");
    expect(job.lessons).toBe(0);
  });
});

describe("what /distill status says about a scan", () => {
  test("running: where it is, and how much it has proposed", () => {
    const job = buildScanJob([target("aaaa1111-2222-7000-8000-000000000060", "retry helper"), target("bbbb2222-3333-7000-8000-000000000061", "")], new Date("2026-09-24T19:12:00.000Z"));
    job.sessions[0]!.status = "done";
    job.sessions[0]!.lessons = 2;
    job.sessions[1]!.status = "running";
    job.lessons = 2;
    job.pid = 4242;

    const line = describeScanJob(job, scanning());
    expect(line).toContain("scan: running since 2026-09-24 19:12");
    expect(line).toContain("session 2 of 2");
    expect(line).toContain("(untitled) · bbbb2222");
    expect(line).toContain("2 lesson(s) so far");
    expect(line).toContain("pid 4242");
  });

  test("running without a detached spawn: a scan in this session says so from the lock alone", () => {
    const job = buildScanJob([target("one", "One")], new Date("2026-09-24T19:12:00.000Z"));
    job.status = "running";
    job.pid = 4242;
    const live = describeScanJob(job, scanning());
    expect(live).toContain("scan: running since");
    expect(live).toContain("(pid 4242)");
  });

  test("interrupted: the journal says running, and the lock is free", () => {
    const job = buildScanJob([target("aaaa1111-2222-7000-8000-000000000060", "retry helper")]);
    job.status = "running";
    job.sessions[0]!.status = "running";

    const line = describeScanJob(job, idle());
    expect(line).toContain("scan: interrupted");
    expect(line).toContain("0 of 1 session(s)");
    expect(line).toContain("nothing holds the scan lock");
    expect(line).toContain("the rest stay eligible");
  });

  test("interrupted with no daemon record at all is still honest", () => {
    const job = buildScanJob([target("one", "")]);
    job.status = "running";
    expect(describeScanJob(job, idle())).toContain("nothing holds the scan lock");
  });

  test("between the spawn and the lock: starting up, not interrupted", () => {
    const job = buildScanJob([target("one", "One")]);
    expect(describeScanJob(job, idle(true))).toContain("scan: starting up");
    // The same journal with no live pid never took the lock: that is an interrupted scan.
    expect(describeScanJob(job, idle())).toContain("interrupted");
  });

  test("over: finished, cancelled and failed each say what they came to", () => {
    const finished = buildScanJob([target("one", "One")], new Date("2026-09-24T19:12:00.000Z"));
    finished.status = "finished";
    finished.endedAt = "2026-09-24T19:20:00.000Z";
    finished.sessions[0]!.status = "done";
    finished.sessions[0]!.lessons = 3;
    finished.lessons = 3;
    expect(describeScanJob(finished, idle())).toContain(
      "scan: finished at 2026-09-24 19:20 — 1 of 1 session(s), 3 lesson(s) proposed",
    );

    const cancelled = buildScanJob([target("one", "One")]);
    cancelled.status = "cancelled";
    cancelled.endedAt = "2026-09-24T19:14:00.000Z";
    expect(describeScanJob(cancelled, idle())).toContain("scan: cancelled");

    const failed = buildScanJob([target("one", "One")]);
    failed.status = "failed";
    failed.errors.push("no evaluator prompt");
    expect(describeScanJob(failed, idle(true))).toContain("no evaluator prompt");

    // Nothing has ever run here: status says nothing about scanning at all.
    expect(describeScanJob(undefined, idle())).toBeUndefined();

    // A held lock with no journal is still worth a line: it is running, and progress is unknown.
    expect(describeScanJob(undefined, scanning())).toContain("left no journal");
  });

  test("a scan whose sessions failed does not read like one that taught nothing", () => {
    const job = buildScanJob([target("one", "One"), target("two", "Two")]);
    job.status = "finished";
    job.endedAt = "2026-09-24T19:20:00.000Z";
    job.sessions[0]!.status = "failed";
    job.sessions[0]!.reason = "the session file is gone";
    job.sessions[1]!.status = "done";
    job.errors.push("one: the session file is gone");

    // Both sessions were attempted, so the count is 2 of 2 — and the failure is named, which is the
    // difference between "it taught nothing" and "it could not read the session".
    const line = describeScanJob(job, idle());
    expect(line).toContain("2 of 2 session(s)");
    expect(line).toContain("0 lesson(s) proposed");
    expect(line).toContain("1 failed: the session file is gone");
  });
});

describe("cancelling a scan", () => {
  test("nothing holds the lock: nothing to cancel, and nothing is written", async () => {
    const distilled = await paths();
    expect(await cancelScanJob(distilled, 10)).toBe("idle");
    expect(await fileExists(cancelRequestPath(distilled))).toBe(false);
  });

  test("a runner that takes the request stops by itself, and no process is harmed", async () => {
    const distilled = await paths();
    const held = await acquireScanLock(distilled, { retries: 1 });
    expect(held).toBeDefined();
    const job = buildScanJob([target("one", "One")]);
    job.status = "running";
    await writeScanJob(distilled, job);

    // A stand-in for the runner noticing the request: the real one polls it every 500 ms, and that
    // path is verified live (a cancelled scan releases the lock on its own). Here the lock is let go
    // once the request is on disk, so the cancel sees a runner that stopped by itself.
    const cancelling = cancelScanJob(distilled, 5_000);
    for (let attempt = 0; attempt < 100 && !(await fileExists(cancelRequestPath(distilled))); attempt++) {
      await scheduler.wait(5);
    }
    expect(await fileExists(cancelRequestPath(distilled))).toBe(true);
    held?.release();

    expect(await cancelling).toBe("cancelled");
  });

  test("a runner that will not stop, with no pid to signal, is reported as unreachable", async () => {
    const distilled = await paths();
    const held = await acquireScanLock(distilled, { retries: 1 });
    expect(held).toBeDefined();
    const job = buildScanJob([target("one", "One")]);
    job.status = "running";
    await writeScanJob(distilled, job);

    // No grace at all: the request is written, the lock is still held, and there is no pid to send a
    // signal to — which is exactly a runner that cannot be reached.
    expect(await cancelScanJob(distilled, 0)).toBe("unreachable");
    expect(await fileExists(cancelRequestPath(distilled))).toBe(true);
    held?.release();
  });
});

describe("starting a scan", () => {
  test("spawns a detached print run of the runner and records its pid", async () => {
    const distilled = await paths();
    const plans: ScanSpawnPlan[] = [];
    __setScanSpawnForTests(async plan => {
      plans.push(plan);
      return { pid: 4242 };
    });

    const job = buildScanJob([target("one", "One")]);
    const started = await startScanJob(distilled, job);

    expect(started).toMatchObject({ ok: true, pid: 4242 });
    expect(plans).toHaveLength(1);
    // The command is the runner's entry point: a print run of `_job`, in the project, detached,
    // and --no-session so the host never attaches it to the project's own newest session.
    expect(plans[0]?.command.slice(1)).toEqual(["-p", "--no-session", "/distill _job"]);
    expect(plans[0]?.command[0]).toContain("omp");
    expect(plans[0]?.cwd).toBe(distilled.projectRoot);
    expect(plans[0]?.logPath).toContain(".omp/distill/tmp/scan.log");
    // The journal exists before the spawn returns, with the pid, so status is never blank.
    expect(await readScanJob(distilled)).toMatchObject({ status: "starting", pid: 4242 });
  });

  test("a spawn that fails leaves the journal for the fallback to run", async () => {
    const distilled = await paths();
    __setScanSpawnForTests(async () => {
      throw new Error("spawn ENOENT");
    });
    const started = await startScanJob(distilled, buildScanJob([target("one", "One")]));
    expect(started).toEqual({ ok: false, reason: "spawn ENOENT" });
    expect(await readScanJob(distilled)).toMatchObject({ status: "starting" });
  });
});
