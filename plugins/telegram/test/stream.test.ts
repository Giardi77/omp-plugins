import { describe, expect, test } from "bun:test";
import { TelegramBotApi } from "../src/bot-api.ts";
import { isRecord } from "../src/config.ts";
import { DRAFT_BUDGET, extractToolOutput, summarizeToolCall, TelegramTurnStream, TurnRenderer } from "../src/stream.ts";

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

function callsTo(calls: Array<{ url: string; body: Record<string, unknown> }>, method: string) {
  return calls.filter(call => call.url.endsWith(`/${method}`));
}

function richField(call: { body: Record<string, unknown> }, field: string): string {
  const richMessage = call.body.rich_message;
  if (isRecord(richMessage)) {
    const value = richMessage[field];
    if (typeof value === "string") return value;
  }
  throw new Error(`expected rich_message.${field} to be a string`);
}

describe("summarizeToolCall", () => {
  test("picks the most identifying argument, first line only", () => {
    expect(summarizeToolCall("bash", { command: "bun test --coverage\n--verbose" })).toBe("bash · bun test --coverage");
    expect(summarizeToolCall("read", { path: "src/auth/session.ts" })).toBe("read · src/auth/session.ts");
    expect(summarizeToolCall("grep", { pattern: "session" })).toBe("grep · session");
  });

  test("falls back to the bare tool name and truncates long values", () => {
    expect(summarizeToolCall("hub", { op: "list" })).toBe("hub");
    const long = summarizeToolCall("bash", { command: "x".repeat(200) });
    expect(long.length).toBeLessThanOrEqual("bash · ".length + 80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("extractToolOutput", () => {
  test("joins text blocks from an AgentToolResult shape", () => {
    const result = { content: [{ type: "text", text: "a" }, { type: "image", data: "…" }, { type: "text", text: "b" }] };
    expect(extractToolOutput(result)).toBe("a\nb");
  });

  test("handles strings, undefined, and enforces the limit", () => {
    expect(extractToolOutput("plain")).toBe("plain");
    expect(extractToolOutput(undefined)).toBe("");
    expect(extractToolOutput("x".repeat(1000), 100).length).toBeLessThanOrEqual(100);
  });
});

describe("TurnRenderer", () => {
  test("ignores non-assistant messages", () => {
    const renderer = new TurnRenderer();
    expect(renderer.messageUpdate({ role: "user", content: "hi" })).toEqual([]);
  });

  test("draft accumulates thinking and streamed text", () => {
    const renderer = new TurnRenderer();
    const actions = renderer.messageUpdate({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "trace the leak" },
        { type: "text", text: "Let me look at session.ts" },
      ],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("draft");
    if (actions[0].kind === "draft") {
      expect(actions[0].markdown).toContain("<tg-thinking>trace the leak</tg-thinking>");
      expect(actions[0].markdown).toContain("Let me look at session.ts");
    }
  });

  test("tool calls render as details blocks, errors marked, and thinking is dropped at turn end", () => {
    const renderer = new TurnRenderer();
    renderer.messageUpdate({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] });
    renderer.toolExecutionStart({ toolCallId: "1", toolName: "bash", args: { command: "bun test" } });
    renderer.toolExecutionEnd({
      toolCallId: "1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "26 pass" }] },
      isError: false,
    });

    const final = renderer.turnEnd();
    expect(final).toHaveLength(1);
    expect(final[0].kind).toBe("final");
    if (final[0].kind === "final") {
      expect(final[0].markdown).not.toContain("tg-thinking");
      expect(final[0].markdown).toContain("bash · bun test");
      expect(final[0].markdown).toContain("26 pass");
      expect(final[0].markdown).toContain("<details>");
    }
  });

  test("failed tools get an error mark", () => {
    const renderer = new TurnRenderer();
    renderer.toolExecutionStart({ toolCallId: "1", toolName: "bash", args: { command: "false" } });
    const actions = renderer.toolExecutionEnd({ toolCallId: "1", toolName: "bash", isError: true, result: "exit 1" });
    if (actions[0].kind === "draft") {
      expect(actions[0].markdown).toContain("❌");
    }
  });

  test("drafts stay within budget on long turns (two-pass compose)", () => {
    const renderer = new TurnRenderer();
    renderer.messageUpdate({ role: "assistant", content: [{ type: "text", text: "x".repeat(50_000) }] });
    for (let i = 0; i < 60; i++) {
      renderer.toolExecutionStart({ toolCallId: `t${i}`, toolName: "bash", args: { command: `cmd-${i}` } });
      renderer.toolExecutionEnd({ toolCallId: `t${i}`, toolName: "bash", result: "y".repeat(550) });
    }
    const [action] = renderer.toolExecutionEnd({ toolCallId: "last", toolName: "bash", result: "z" });
    expect(action.kind).toBe("draft");
    if (action.kind === "draft") {
      expect(action.markdown.length).toBeLessThanOrEqual(DRAFT_BUDGET);
    }
  });
});

describe("TelegramTurnStream", () => {
  const chatId = 42;

  test("coalesces rapid drafts to first + latest", async () => {
    const { calls, fetchImpl } = scriptedFetch([]);
    const stream = new TelegramTurnStream(new TelegramBotApi("t", fetchImpl), chatId, () => undefined, () => {}, 0);
    stream.push({ kind: "draft", markdown: "d1" });
    stream.push({ kind: "draft", markdown: "d2" });
    stream.push({ kind: "draft", markdown: "d3" });
    await stream.flush();

    const drafts = callsTo(calls, "sendRichMessageDraft");
    expect(drafts).toHaveLength(2);
    expect(richField(drafts[0], "markdown")).toBe("d1");
    expect(richField(drafts[1], "markdown")).toBe("d3");
  });

  test("final supersedes pending drafts and bumps the draft id", async () => {
    const { calls, fetchImpl } = scriptedFetch([]);
    const stream = new TelegramTurnStream(new TelegramBotApi("t", fetchImpl), chatId, () => undefined, () => {}, 0);
    stream.push({ kind: "draft", markdown: "draft" });
    stream.push({ kind: "final", markdown: "final" });
    await stream.flush();

    const finals = callsTo(calls, "sendRichMessage");
    expect(finals).toHaveLength(1);
    expect(richField(finals[0], "markdown")).toBe("final");
  });

  test("falls back to plain html when telegram rejects markdown", async () => {
    const { calls, fetchImpl } = scriptedFetch([{ ok: false, status: 400, description: "can't parse entities" }]);
    const stream = new TelegramTurnStream(new TelegramBotApi("t", fetchImpl), chatId, () => undefined, () => {}, 0);
    stream.push({ kind: "draft", markdown: "**unbalanced" });
    await stream.flush();

    const drafts = callsTo(calls, "sendRichMessageDraft");
    expect(drafts).toHaveLength(2);
    expect(richField(drafts[0], "markdown")).toBe("**unbalanced");
    expect(richField(drafts[1], "html")).toContain("**unbalanced");
  });

  test("paginates finals over the message budget", async () => {
    const { calls, fetchImpl } = scriptedFetch([]);
    const stream = new TelegramTurnStream(new TelegramBotApi("t", fetchImpl), chatId, () => undefined, () => {}, 0);
    const big = `${"a".repeat(29_000)}\n${"b".repeat(29_000)}`;
    stream.push({ kind: "final", markdown: big });
    await stream.flush();

    const finals = callsTo(calls, "sendRichMessage");
    expect(finals).toHaveLength(2);
    expect(finals.map(call => richField(call, "markdown")).join("")).toBe(big);
  });

  test("routes to the current thread id", async () => {
    const { calls, fetchImpl } = scriptedFetch([]);
    const stream = new TelegramTurnStream(new TelegramBotApi("t", fetchImpl), chatId, () => 777, () => {}, 0);
    stream.push({ kind: "final", markdown: "in a topic" });
    await stream.flush();
    expect(callsTo(calls, "sendRichMessage")[0].body.message_thread_id).toBe(777);
  });
});
