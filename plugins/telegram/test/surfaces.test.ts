import { describe, expect, test } from "bun:test";
import { TelegramBotApi, type TelegramUpdate } from "../src/bot-api.ts";
import type { UpdateSubscriber } from "../src/pairing.ts";
import { createSettleCell, makeTelegramApprovalSurface } from "../src/surfaces.ts";

function harness() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (url.endsWith("/sendRichMessage")) {
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: 42, type: "private" }, date: 0 } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
  const listeners = new Set<(update: TelegramUpdate) => unknown>();
  const subscribe: UpdateSubscriber = listener => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const emit = (update: TelegramUpdate) => {
    for (const listener of [...listeners]) listener(update);
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { api: new TelegramBotApi("t", fetchImpl), calls, subscribe, emit, listeners, flush };
}

function tap(messageId: number, data: string): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: 7, is_bot: false, first_name: "G" },
      message: { message_id: messageId, chat: { id: 42, type: "private" }, date: 0 },
      data,
    },
  };
}

function editsContaining(calls: Array<{ url: string; body: Record<string, unknown> }>, text: string) {
  return calls.filter(call => call.url.endsWith("/editMessageText") && JSON.stringify(call.body).includes(text));
}

describe("telegram approval surface", () => {
  test("a tap resolves the decision, edits the card, and unsubscribes", async () => {
    const { api, subscribe, emit, listeners, calls, flush } = harness();
    const surface = makeTelegramApprovalSurface({ api, chatId: 42, threadId: () => undefined, subscribe, settleCell: createSettleCell() });
    const pending = surface({ toolName: "bash", summary: "bash · bun test" });
    await flush();
    expect(listeners.size).toBe(1);

    emit(tap(10, "approve"));
    expect(await pending).toBe("approve");
    expect(listeners.size).toBe(0);
    expect(editsContaining(calls, "Approved")).toHaveLength(1);
  });

  test("settlement elsewhere detaches the listener and shows the real verdict; late taps do nothing", async () => {
    const { api, subscribe, emit, listeners, calls, flush } = harness();
    const settleCell = createSettleCell();
    const surface = makeTelegramApprovalSurface({ api, chatId: 42, threadId: () => undefined, subscribe, settleCell });
    let resolved: string | undefined;
    // The surface promise intentionally never settles after an elsewhere-settlement —
    // resolving could inject a phantom decision — so capture via then, never await it.
    void surface({ toolName: "bash", summary: "bash · rm -rf build" }).then(decision => {
      resolved = decision;
    });
    await flush();

    settleCell.settle("❌ Denied");
    expect(listeners.size).toBe(0);

    emit(tap(10, "approve")); // too late — the listener is gone
    await flush();
    expect(resolved).toBeUndefined();
    expect(editsContaining(calls, "Denied")).toHaveLength(1);
    expect(editsContaining(calls, "Approved")).toHaveLength(0);
  });
});
