import { afterEach, describe, expect, test } from "bun:test";
import { distillPaths } from "../src/config";
import {
  __setScanBrokerForTests,
  buildScanJob,
  cancelScanJob,
  cancelRequestPath,
  clearCancelRequest,
  describeScanJob,
  readScanJob,
  scanJobPath,
  writeScanJob,
  type ScanBroker,
  type ScanDaemonRecord,
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

function daemon(overrides: Partial<ScanDaemonRecord> = {}): ScanDaemonRecord {
  return { name: "distill-scan", state: "running", pid: 4242, ...overrides };
}

afterEach(() => {
  __setScanBrokerForTests(undefined);
});

describe("a scan's journal", () => {
  test("survives a round trip, and a foreign or half-written file reads as nothing", async () => {
    const distilled = await paths();
    const job = buildScanJob([{ sessionId: "aaaa1111-2222-7000-8000-000000000060", title: "retry helper" }]);
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
    const job = buildScanJob([
      { sessionId: "one", title: "" },
      { sessionId: "two", title: "Two" },
    ]);
    expect(job.status).toBe("starting");
    expect(job.sessions.map(session => session.status)).toEqual(["pending", "pending"]);
    expect(job.sessions[1]?.title).toBe("Two");
    expect(job.lessons).toBe(0);
  });
});

describe("what /distill status says about a scan", () => {
  test("running: where it is, and how much it has proposed", () => {
    const job = buildScanJob(
      [
        { sessionId: "aaaa1111-2222-7000-8000-000000000060", title: "retry helper" },
        { sessionId: "bbbb2222-3333-7000-8000-000000000061", title: "" },
      ],
      new Date("2026-09-24T19:12:00.000Z"),
    );
    job.sessions[0]!.status = "done";
    job.sessions[0]!.lessons = 2;
    job.sessions[1]!.status = "running";
    job.lessons = 2;

    const line = describeScanJob(job, daemon());
    expect(line).toContain("scan: running since 2026-09-24 19:12");
    expect(line).toContain("session 2 of 2");
    expect(line).toContain("(untitled) · bbbb2222");
    expect(line).toContain("2 lesson(s) so far");
    expect(line).toContain("pid 4242");
  });

  test("interrupted: the journal says running, and the runner is gone", () => {
    const job = buildScanJob([{ sessionId: "aaaa1111-2222-7000-8000-000000000060", title: "retry helper" }]);
    job.status = "running";
    job.sessions[0]!.status = "running";

    const line = describeScanJob(job, daemon({ state: "exited", exitReason: "SIGKILL", pid: undefined }));
    expect(line).toContain("scan: interrupted");
    expect(line).toContain("0 of 1 session(s)");
    expect(line).toContain("SIGKILL");
    expect(line).toContain("the rest stay eligible");
  });

  test("interrupted in-process: no daemon record at all is still honest", () => {
    const job = buildScanJob([{ sessionId: "one", title: "" }]);
    job.status = "running";
    expect(describeScanJob(job, undefined)).toContain("no daemon record");
  });

  test("an in-process scan reads as running from its own pid, and stops being one when it is gone", () => {
    const job = buildScanJob([{ sessionId: "one", title: "One" }], new Date("2026-09-24T19:12:00.000Z"));
    job.status = "running";
    job.pid = process.pid;
    const live = describeScanJob(job, undefined);
    expect(live).toContain("scan: running since");
    expect(live).toContain(`(pid ${process.pid})`);

    // The same journal with a pid that cannot be alive: this is what a killed OMP leaves behind.
    job.pid = 2_147_483_646;
    expect(describeScanJob(job, undefined)).toContain("scan: interrupted");
  });

  test("over: finished, cancelled and failed each say what they came to", () => {
    const finished = buildScanJob([{ sessionId: "one", title: "One" }], new Date("2026-09-24T19:12:00.000Z"));
    finished.status = "finished";
    finished.endedAt = "2026-09-24T19:20:00.000Z";
    finished.sessions[0]!.status = "done";
    finished.sessions[0]!.lessons = 3;
    finished.lessons = 3;
    expect(describeScanJob(finished, daemon({ state: "exited", exitCode: 0 }))).toContain(
      "scan: finished at 2026-09-24 19:20 — 1 of 1 session(s), 3 lesson(s) proposed",
    );

    const cancelled = buildScanJob([{ sessionId: "one", title: "One" }]);
    cancelled.status = "cancelled";
    cancelled.endedAt = "2026-09-24T19:14:00.000Z";
    expect(describeScanJob(cancelled, daemon({ state: "exited" }))).toContain("scan: cancelled");

    const failed = buildScanJob([{ sessionId: "one", title: "One" }]);
    failed.status = "failed";
    failed.errors.push("no evaluator prompt");
    expect(describeScanJob(failed, daemon({ state: "failed", exitReason: "exit 1" }))).toContain("no evaluator prompt");

    // Nothing has ever run here: status says nothing about scanning at all.
    expect(describeScanJob(undefined, undefined)).toBeUndefined();

    // A daemon without a journal is still worth a line: it is running, and progress is unknown.
    const orphan = describeScanJob(undefined, daemon());
    expect(orphan).toContain("scan: running since an unknown time");
    expect(orphan).toContain("0 lesson(s) so far");

    // The same, with the daemon already gone: there is nothing left to read.
    const gone = describeScanJob(undefined, daemon({ state: "exited", exitReason: "exit 1" }));
    expect(gone).toContain("no journal was left");
    expect(gone).toContain("exit 1");
  });
});

describe("cancelling a scan", () => {
  function broker(options: { exits: boolean }): { broker: ScanBroker; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      broker: {
        start: async () => {
          calls.push("start");
          return { pid: 1 };
        },
        list: async () => [daemon()],
        waitForExit: async () => {
          calls.push("wait");
          return options.exits;
        },
        stop: async () => {
          calls.push("stop");
          return true;
        },
      },
    };
  }

  test("asks the runner to stop first, and only kills it if it will not", async () => {
    const distilled = await paths();
    const graceful = broker({ exits: true });
    __setScanBrokerForTests(graceful.broker);

    expect(await cancelScanJob(distilled, 10)).toBe("cancelled");
    expect(await fileExists(cancelRequestPath(distilled))).toBe(true);
    expect(graceful.calls).toEqual(["wait"]);

    // The runner that will not go: the request stays, and the broker's hammer follows.
    await clearCancelRequest(distilled);
    const stubborn = broker({ exits: false });
    __setScanBrokerForTests(stubborn.broker);
    expect(await cancelScanJob(distilled, 10)).toBe("stopped");
    expect(stubborn.calls).toEqual(["wait", "stop"]);
  });

  test("nothing running is not an error", async () => {
    const distilled = await paths();
    __setScanBrokerForTests({
      start: async () => ({}),
      list: async () => [daemon({ state: "exited", pid: undefined })],
      waitForExit: async () => true,
      stop: async () => true,
    });
    expect(await cancelScanJob(distilled, 10)).toBe("idle");
    expect(await fileExists(cancelRequestPath(distilled))).toBe(false);
  });

  test("a scan running in this session is asked to stop, broker or no broker", async () => {
    const distilled = await paths();
    const job = buildScanJob([{ sessionId: "one", title: "One" }]);
    job.status = "running";
    job.pid = process.pid;
    await writeScanJob(distilled, job);

    // No broker to escalate to: the request the runner polls is the whole mechanism, and the runner
    // here is in this process, so nothing else needs to happen.
    __setScanBrokerForTests({
      start: async () => ({}),
      list: async () => {
        throw new Error("no broker");
      },
      waitForExit: async () => false,
      stop: async () => false,
    });
    expect(await cancelScanJob(distilled, 10)).toBe("cancelled");
    expect(await fileExists(cancelRequestPath(distilled))).toBe(true);

    // And a journal that is over is nothing to cancel.
    await clearCancelRequest(distilled);
    job.status = "finished";
    await writeScanJob(distilled, job);
    expect(await cancelScanJob(distilled, 10)).toBe("idle");
  });
});
