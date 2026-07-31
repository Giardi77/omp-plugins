import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  chunkText,
  PollingUpdateSource,
  RateLimiter,
  TelegramApiError,
  TelegramBotApi,
  TELEGRAM_MESSAGE_LIMIT,
  type TelegramUpdate,
} from "../src/bot-api.ts";
import { acquireInstanceLock, InstanceLockedError } from "../src/lock.ts";
import { generatePairingCode, PAIRING_CODE_LENGTH, PairingTimeoutError, waitForPairing } from "../src/pairing.ts";

type FetchStep = { ok: true; result: unknown } | { ok: false; status: number; description: string } | { reject: Error };

function scriptedFetch(steps: FetchStep[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const step = steps.shift() ?? { ok: true as const, result: [] };
    if ("reject" in step) throw step.reject;
    const status = step.ok ? 200 : step.status;
    const payload = step.ok ? { ok: true, result: step.result } : { ok: false, description: step.description };
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, fetchImpl };
}

describe("chunkText", () => {
  test("empty text yields no chunks", () => {
    expect(chunkText("")).toEqual([]);
  });

  test("text within the limit stays a single chunk", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("x".repeat(TELEGRAM_MESSAGE_LIMIT))).toHaveLength(1);
  });

  test("splits at newlines when possible and hard-splits otherwise, always lossless", () => {
    const cases = [
      `${"a".repeat(4000)}\n${"b".repeat(4000)}\n${"c".repeat(4000)}`,
      "x".repeat(9000),
      `${"line\n".repeat(2000)}tail`,
    ];
    for (const text of cases) {
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
  });

  test("prefers keeping the newline at the end of the chunk", () => {
    const text = `${"a".repeat(100)}\n${"b".repeat(100)}`;
    expect(chunkText(text, 101)).toEqual([`${"a".repeat(100)}\n`, "b".repeat(100)]);
  });
});

describe("RateLimiter", () => {
  test("first call is immediate, subsequent calls are spaced", async () => {
    const delays: number[] = [];
    const limiter = new RateLimiter(100, async ms => {
      delays.push(ms);
    });
    await limiter.wait();
    await limiter.wait();
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(50);
    expect(delays[0]).toBeLessThanOrEqual(100);
  });
});

describe("TelegramBotApi.call", () => {
  test("passes an abort signal that fires after the timeout, so calls cannot hang forever", async () => {
    let observedSignal: AbortSignal | undefined;
    const hangingFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      observedSignal = init?.signal ?? undefined;
      const { promise, reject } = Promise.withResolvers<Response>();
      observedSignal?.addEventListener("abort", () => reject(new Error("aborted")));
      return promise;
    };
    const api = new TelegramBotApi("test-token", hangingFetch);
    await expect(api.call("getMe", {}, 20)).rejects.toThrow("aborted");
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("PollingUpdateSource", () => {
  test("retries transient errors, advances the offset, and stops permanently on 409 conflict", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      { reject: new Error("socket hangup") },
      { ok: true, result: [{ update_id: 41 }, { update_id: 42 }] },
      { ok: false, status: 409, description: "terminated by other getUpdates request" },
    ]);
    const api = new TelegramBotApi("test-token", fetchImpl);
    const source = new PollingUpdateSource(api, { timeoutSeconds: 0, sleep: async () => {} });
    const received: number[] = [];
    const errors: Error[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    source.start(
      update => {
        received.push(update.update_id);
      },
      error => {
        errors.push(error);
        if (error instanceof TelegramApiError && error.isConflict) resolve();
      },
    );
    await promise;

    expect(received).toEqual([41, 42]);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toContain("socket hangup");
    expect(errors[1]).toBeInstanceOf(TelegramApiError);
    expect(source.running).toBe(false);
    // The request carrying offset 43 proves the delivered updates advanced the cursor.
    expect(calls[2].body.offset).toBe(43);
  });
});

describe("pairing", () => {
  test("generatePairingCode emits fixed-length codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(code)).toBe(true);
    }
  });

  function listenerHub() {
    const listeners = new Set<(update: TelegramUpdate) => void>();
    const subscribe = (listener: (update: TelegramUpdate) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const emit = (text: string, updateId: number) => {
      const update: TelegramUpdate = {
        update_id: updateId,
        message: {
          message_id: updateId,
          chat: { id: 555, type: "private" },
          date: 0,
          from: { id: 7, is_bot: false, first_name: "Giardi" },
          text,
        },
      };
      for (const listener of [...listeners]) listener(update);
    };
    return { subscribe, emit, listeners };
  }

  test("waitForPairing resolves on the exact code and ignores everything else", async () => {
    const { subscribe, emit, listeners } = listenerHub();
    const promise = waitForPairing(subscribe, "ABC123", { timeoutMs: 1000 });
    emit("hello", 1);
    emit("ABC1234", 2);
    emit("prefix ABC123", 3);
    emit("ABC123", 4);
    await expect(promise).resolves.toMatchObject({ chatId: 555, userId: 7 });
    expect(listeners.size).toBe(0);
  });

  test("waitForPairing accepts /start <code>", async () => {
    const { subscribe, emit } = listenerHub();
    const promise = waitForPairing(subscribe, "ABC123", { timeoutMs: 1000 });
    emit("/start ABC123", 1);
    await expect(promise).resolves.toMatchObject({ chatId: 555 });
  });

  test("waitForPairing rejects on timeout and unsubscribes", async () => {
    vi.useFakeTimers();
    try {
      const { subscribe, listeners } = listenerHub();
      const promise = waitForPairing(subscribe, "ABC123", { timeoutMs: 1000 });
      vi.advanceTimersByTime(1000);
      await expect(promise).rejects.toBeInstanceOf(PairingTimeoutError);
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("instance lock", () => {
  async function tempLockPath(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-telegram-lock-"));
    return path.join(dir, "telegram.lock");
  }

  test("fails loudly when a live foreign process holds the lock", async () => {
    const lockPath = await tempLockPath();
    await Bun.write(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
    await expect(acquireInstanceLock(lockPath)).rejects.toBeInstanceOf(InstanceLockedError);
  });

  test("reclaims stale locks and release removes only our own lock file", async () => {
    const lockPath = await tempLockPath();
    await Bun.write(lockPath, JSON.stringify({ pid: 4_000_000, startedAt: new Date().toISOString() }));
    const release = await acquireInstanceLock(lockPath);
    await release();
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });
});
