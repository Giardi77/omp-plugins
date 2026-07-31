import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "./config.ts";

/**
 * Single-consumer guard: one bot token tolerates exactly one getUpdates poller
 * (a second one gets 409 Conflict and the two steal updates from each other).
 * Stale locks (dead pid) are reclaimed; a live foreign pid fails loudly.
 */

export class InstanceLockedError extends Error {
  constructor(readonly holderPid: number) {
    super(`Another OMP session (pid ${holderPid}) is already bridging this Telegram bot`);
    this.name = "InstanceLockedError";
  }
}

interface LockFile {
  pid: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(lockPath: string): Promise<LockFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(lockPath).text());
    if (isRecord(parsed) && typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Acquire the lock; returns a release that only removes a lock file still owned by us. */
export async function acquireInstanceLock(lockPath: string): Promise<() => Promise<void>> {
  const existing = await readLock(lockPath);
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    throw new InstanceLockedError(existing.pid);
  }
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await Bun.write(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => {
    const current = await readLock(lockPath);
    if (current?.pid === process.pid) await fs.rm(lockPath, { force: true });
  };
}
