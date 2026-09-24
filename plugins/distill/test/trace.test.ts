import { describe, expect, test } from "bun:test";
import { loadSession, resolveBranch } from "../src/store";
import { buildBundle, MAX_EXCERPT_CHARS, renderPayload, excerptFor } from "../src/trace";
import {
  advisorMessage,
  assistantMessage,
  customEntry,
  developerMessage,
  makeTempDir,
  modelChange,
  serviceTierChange,
  textPart,
  thinkingLevelChange,
  thinkingPart,
  titleChange,
  toolCallPart,
  entriesOf,
  toolResultMessage,
  userMessage,
  writeSessionFixture,
} from "./fixtures";

const SESSION_ID = "01a0ced4-1111-7000-8000-000000000010";
const SUBAGENT_ID = "01a0ced4-2222-7000-8000-000000000011";

async function awkwardSession() {
  const dir = await makeTempDir("omp-distill-trace-");
  const cwd = "/work/alpha";
  const sessionPath = await writeSessionFixture({
    dir,
    sessionId: SESSION_ID,
    cwd,
    titleSlotTitle: "flaky retry test",
    lines: [
      userMessage({ id: "10000001", parentId: null }, "Please fix the flaky retry test"),
      assistantMessage({ id: "10000002", parentId: "10000001" }, [textPart("Looking at the retry helper.")], {
        usage: { input: 1200, output: 40, cacheRead: 800, cacheWrite: 0, totalTokens: 2040, cost: { total: 0.0123 } },
      }),
      modelChange({ id: "10000003", parentId: "10000002" }, "anthropic/claude-sonnet"),
      thinkingLevelChange({ id: "10000004", parentId: "10000003" }, "high"),
      serviceTierChange({ id: "10000005", parentId: "10000004" }, { openai: "priority" }),
      titleChange({ id: "10000006", parentId: "10000005" }, "Flaky retry test"),
      developerMessage({ id: "10000007", parentId: "10000006" }, "developer scaffolding, never traced"),
      assistantMessage({ id: "10000008", parentId: "10000007" }, [thinkingPart("maybe the sleep is the issue")]),
      assistantMessage({ id: "10000009", parentId: "10000008" }, [
        toolCallPart("call_1", "edit", { path: "src/retry.ts", oldString: "sleep(100)", newString: "sleep(250)" }),
      ]),
      toolResultMessage({ id: "1000000a", parentId: "10000009" }, {
        toolCallId: "call_1",
        toolName: "edit",
        text: 'Tool "edit" is blocked by user policy.\nTo allow: remove "tools.approval.edit: deny" from config.',
        isError: true,
      }),
      advisorMessage({ id: "1000000b", parentId: "1000000a" }, "Consider the retry budget."),
      customEntry({ id: "1000000c", parentId: "1000000b" }, "todo_hud_state", { items: [] }),
      assistantMessage({ id: "1000000d", parentId: "1000000c" }, [toolCallPart("call_2", "read", { path: "src/retry.ts" })]),
      toolResultMessage({ id: "1000000e", parentId: "1000000d" }, {
        toolCallId: "call_2",
        toolName: "read",
        text: "export function retry(fn: () => Promise<void>) { /* ... */ }",
      }),
    ],
    subagents: [
      {
        name: "Worker",
        sessionId: SUBAGENT_ID,
        lines: [userMessage({ id: "20000001", parentId: null }, "check the retry helper")],
      },
    ],
  });
  const loaded = await loadSession(sessionPath);
  if (!loaded.ok) throw new Error(loaded.reason);
  return { cwd, sessionPath, session: loaded.session };
}

describe("payload rendering", () => {
  test("carries prompts, tool traffic, injected messages and change records", async () => {
    const { cwd, sessionPath, session } = await awkwardSession();
    const bundle = buildBundle({
      projectRoot: cwd,
      sessionId: session.header.id,
      sessionFile: sessionPath,
      parent: resolveBranch(session.entries),
      subagents: [],
    });

    const payload = renderPayload(bundle, { includeThinking: false });

    expect(payload).toContain("## trace 01a0ced4 — parent session");
    expect(payload).toContain("[10000001] user: Please fix the flaky retry test");
    expect(payload).toContain("[10000002] assistant: Looking at the retry helper.");
    expect(payload).toContain("[10000002] usage: input 1200, output 40, cacheRead 800, cacheWrite 0, total 2040, cost $0.0123");
    expect(payload).toContain("[10000003] model: anthropic/claude-sonnet");
    expect(payload).toContain("[10000004] thinkingLevel: high");
    expect(payload).toContain('[10000005] serviceTier: {"openai":"priority"}');
    expect(payload).toContain("[10000006] title: Flaky retry test");
    expect(payload).toContain('[10000009] assistant toolCall edit: {"path":"src/retry.ts"');
    expect(payload).toContain('[1000000a] toolResult edit error: Tool "edit" is blocked by user policy.');
    expect(payload).toContain("[1000000b] injected advisor (agent): Consider the retry budget.");
    expect(payload).toContain("[1000000e] toolResult read: export function retry");
    expect(payload).not.toContain("developer scaffolding");
    expect(payload).not.toContain("maybe the sleep is the issue");
    expect(payload).not.toContain("todo_hud_state");
  });

  test("reasoning text is opt-in", async () => {
    const { cwd, sessionPath, session } = await awkwardSession();
    const bundle = buildBundle({
      projectRoot: cwd,
      sessionId: session.header.id,
      sessionFile: sessionPath,
      parent: resolveBranch(session.entries),
      subagents: [],
    });

    const payload = renderPayload(bundle, { includeThinking: true });
    expect(payload).toContain("[10000008] thinking: maybe the sleep is the issue");
  });

  test("a subagent's trace rides the same payload under its own id", async () => {
    const { cwd, sessionPath, session } = await awkwardSession();
    const bundle = buildBundle({
      projectRoot: cwd,
      sessionId: session.header.id,
      sessionFile: sessionPath,
      parent: resolveBranch(session.entries),
      subagents: [
        {
          label: "Worker",
          sessionId: SUBAGENT_ID,
          sessionFile: `${sessionPath.slice(0, -".jsonl".length)}/Worker.jsonl`,
          entries: entriesOf([userMessage({ id: "20000001", parentId: null }, "check the retry helper")]),
        },
      ],
    });

    const payload = renderPayload(bundle, { includeThinking: false });
    expect(payload).toContain("## trace 01a0ced42222 — subagent Worker");
    expect(payload).toContain("traces: 2");
  });

  test("colliding session prefixes still get distinct trace ids", () => {
    const bundle = buildBundle({
      projectRoot: "/work/alpha",
      sessionId: "abcdef123456-1111",
      sessionFile: "/tmp/a.jsonl",
      parent: [],
      subagents: [
        { label: "first", sessionId: "abcdef123456-2222", sessionFile: "/tmp/b.jsonl", entries: [] },
        { label: "second", sessionId: "abcdef12ffff-3333", sessionFile: "/tmp/c.jsonl", entries: [] },
      ],
    });
    const ids = bundle.traces.map(trace => trace.id);
    expect(ids[0]).toBe("abcdef12");
    expect(new Set(ids).size).toBe(3);
    expect(ids[1]).toBe("abcdef123456");
  });
});

describe("excerpts", () => {
  test("are verbatim slices of the cited record, capped", async () => {
    const { session } = await awkwardSession();
    const branch = resolveBranch(session.entries);
    const denial = branch.find(entry => entry.id === "1000000a");
    expect(denial).toBeDefined();
    if (!denial) return;

    expect(excerptFor(denial)).toBe(
      'toolResult edit error: Tool "edit" is blocked by user policy.\nTo allow: remove "tools.approval.edit: deny" from config.',
    );

    const [long] = entriesOf([
      userMessage({ id: "30000001", parentId: null }, "x".repeat(MAX_EXCERPT_CHARS + 50)),
    ]);
    const excerpt = excerptFor(long!);
    expect(excerpt.length).toBeLessThan(MAX_EXCERPT_CHARS + 100);
    expect(excerpt).toContain("characters omitted]");
  });
});
