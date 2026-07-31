import { describe, expect, test } from "bun:test";
import { TelegramBotApi } from "../src/bot-api.ts";
import { TopicRouter, type TopicStore } from "../src/topics.ts";

type FetchStep = { ok: true; result: unknown } | { ok: false; status: number; description: string };

function scriptedFetch(steps: FetchStep[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const step = steps.shift() ?? { ok: true as const, result: true };
    const status = step.ok ? 200 : step.status;
    const payload = step.ok ? { ok: true, result: step.result } : { ok: false, description: step.description };
    return new Response(JSON.stringify(payload), { status });
  };
  return { calls, fetchImpl };
}

function memoryStore(initial: Record<string, number> = {}) {
  const store: TopicStore & { data: Record<string, number> } = {
    data: { ...initial },
    load: async () => ({ ...store.data }),
    save: async topics => {
      store.data = { ...topics };
    },
  };
  return store;
}

function getMeStep(hasTopics: boolean): FetchStep {
  return { ok: true, result: { id: 1, is_bot: true, first_name: "b", has_topics_enabled: hasTopics } };
}

describe("TopicRouter", () => {
  test("flat mode when the bot lacks Threaded Mode: no topics, no API calls", async () => {
    const { calls, fetchImpl } = scriptedFetch([getMeStep(false)]);
    const router = await TopicRouter.connect(new TelegramBotApi("t", fetchImpl), 42, memoryStore());

    expect(router.topicsEnabled).toBe(false);
    expect(await router.ensureTopic("s1", "fix auth")).toBeUndefined();
    expect(router.threadFor("s1")).toBeUndefined();
    expect(calls.filter(call => call.url.endsWith("/createForumTopic"))).toHaveLength(0);
  });

  test("topics mode: creates once, caches, persists, and reuses", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      getMeStep(true),
      { ok: true, result: { message_thread_id: 99, name: "fix auth" } },
    ]);
    const store = memoryStore({ earlier: 7 });
    const router = await TopicRouter.connect(new TelegramBotApi("t", fetchImpl), 42, store);

    expect(router.topicsEnabled).toBe(true);
    expect(router.threadFor("earlier")).toBe(7);

    const created = await router.ensureTopic("s1", "fix auth");
    expect(created).toBe(99);
    expect(router.threadFor("s1")).toBe(99);
    expect(store.data).toEqual({ earlier: 7, s1: 99 });

    const again = await router.ensureTopic("s1", "fix auth");
    expect(again).toBe(99);
    expect(calls.filter(call => call.url.endsWith("/createForumTopic"))).toHaveLength(1);

    // reverse lookup drives inbound topic binding
    expect(router.sessionFor(99)).toBe("s1");
    expect(router.sessionFor(7)).toBe("earlier");
    expect(router.sessionFor(12345)).toBeUndefined();
  });

  test("topic names are capped at the API limit", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      getMeStep(true),
      { ok: true, result: { message_thread_id: 5, name: "x" } },
    ]);
    const router = await TopicRouter.connect(new TelegramBotApi("t", fetchImpl), 42, memoryStore());
    await router.ensureTopic("s1", "n".repeat(500));
    const createCalls = calls.filter(call => call.url.endsWith("/createForumTopic"));
    const name = createCalls[0].body.name;
    if (typeof name !== "string") throw new Error("expected a string topic name");
    expect(name.length).toBe(128);
  });
});
