import { describe, expect, test } from "bun:test";
import { loadSession, resolveBranch } from "../src/store";
import { buildBundle, excerptFor, MAX_SECTION_CHARS, renderInventory, renderTraceSection } from "../src/trace";
import {
  advisorMessage,
  assistantMessage,
  customEntry,
  developerMessage,
  entriesOf,
  makeTempDir,
  modelChange,
  serviceTierChange,
  textPart,
  thinkingLevelChange,
  thinkingPart,
  titleChange,
  toolCallPart,
  toolResultMessage,
  userMessage,
  writeSessionFixture,
} from "./fixtures";

const SESSION_ID = "01a0ced4-1111-7000-8000-000000000010";
const SUBAGENT_ID = "01a0ced4-2222-7000-8000-000000000011";
const OPTIONS = { includeThinking: false };

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

async function awkwardBundle() {
  const { cwd, sessionPath, session } = await awkwardSession();
  return buildBundle({
    projectRoot: cwd,
    sessionId: session.header.id,
    sessionFile: sessionPath,
    parent: resolveBranch(session.entries),
    subagents: [],
  });
}

describe("the payload", () => {
  test("is an inventory: what each trace holds, where it lives, and no records", async () => {
    const bundle = await awkwardBundle();
    const payload = renderInventory(bundle, OPTIONS);

    expect(payload).toContain("# distill payload");
    expect(payload).toContain(`session: ${SESSION_ID}`);
    expect(payload).toContain("traces: 1");
    expect(payload).toContain("## trace 01a0ced4 — parent session");
    expect(payload).toContain("records 1..14");
    expect(payload).toMatch(/chars \d+/);
    expect(payload).toContain(`file ${bundle.traces[0]?.sessionFile}`);

    // Not one record: reading happens through get_trace, a section at a time (ADR-0013).
    expect(payload).not.toContain("10000001");
    expect(payload).not.toContain("fix the flaky retry test");
  });
});

describe("trace sections", () => {
  test("carry prompts, tool traffic, injected messages and change records", async () => {
    const bundle = await awkwardBundle();
    const trace = bundle.traces[0];
    if (!trace) throw new Error("no trace");
    const section = renderTraceSection(trace, OPTIONS);

    expect(section.total).toBe(14);
    expect(section.first).toBe(1);
    expect(section.last).toBe(14);
    expect(section.truncated).toBe(false);

    expect(section.text).toContain("[10000001] user: Please fix the flaky retry test");
    expect(section.text).toContain("[10000002] assistant: Looking at the retry helper.");
    expect(section.text).toContain("[10000002] usage: input 1200, output 40, cacheRead 800, cacheWrite 0, total 2040, cost $0.0123");
    expect(section.text).toContain("[10000003] model: anthropic/claude-sonnet");
    expect(section.text).toContain("[10000004] thinkingLevel: high");
    expect(section.text).toContain('[10000005] serviceTier: {"openai":"priority"}');
    expect(section.text).toContain("[10000006] title: Flaky retry test");
    expect(section.text).toContain('[10000009] assistant toolCall edit: {"path":"src/retry.ts"');
    expect(section.text).toContain('[1000000a] toolResult edit error: Tool "edit" is blocked by user policy.');
    expect(section.text).toContain("[1000000b] injected advisor (agent): Consider the retry budget.");
    expect(section.text).toContain("[1000000e] toolResult read: export function retry");
    expect(section.text).not.toContain("developer scaffolding");
    expect(section.text).not.toContain("todo_hud_state");
    expect(section.text).not.toContain("maybe the sleep is the issue");
  });

  test("reasoning text is opt-in", async () => {
    const bundle = await awkwardBundle();
    const trace = bundle.traces[0];
    if (!trace) throw new Error("no trace");

    expect(renderTraceSection(trace, { includeThinking: true }).text).toContain(
      "[10000008] thinking: maybe the sleep is the issue",
    );
  });

  test("ranges, patterns and limits each say what they returned and where to continue", async () => {
    const bundle = await awkwardBundle();
    const trace = bundle.traces[0];
    if (!trace) throw new Error("no trace");

    const head = renderTraceSection(trace, OPTIONS, { from: 1, to: 3 });
    expect(head.text).toContain("[10000001] user:");
    expect(head.text).not.toContain("[10000004]");
    expect(head.text).toContain("section: records 1..3 of 14");
    expect(head.text).toContain('next: get_trace trace="01a0ced4" from=4');

    const matched = renderTraceSection(trace, OPTIONS, { pattern: "blocked by user policy" });
    expect(matched.matched).toBe(1);
    expect(matched.text).toContain("pattern \"blocked by user policy\" — 1 match(es)");
    expect(matched.text).toContain("[1000000a] toolResult edit error");
    expect(matched.text).toContain("end of what you asked for");

    // More matches than the limit: the footer says where in the *matches* to continue.
    const many = renderTraceSection(trace, OPTIONS, { pattern: "retry", limit: 1 });
    expect(many.matched).toBeGreaterThan(1);
    expect(many.text).toContain('next: get_trace trace="01a0ced4" pattern="retry" from=');

    const limited = renderTraceSection(trace, OPTIONS, { limit: 2 });
    expect(limited.last).toBe(2);
    expect(limited.truncated).toBe(true);
    expect(limited.text).toContain("next: get_trace");

    const nothing = renderTraceSection(trace, OPTIONS, { pattern: "no such text anywhere" });
    expect(nothing.first).toBe(0);
    expect(nothing.text).toContain("nothing matched");

    const past = renderTraceSection(trace, OPTIONS, { from: 99 });
    expect(past.first).toBe(0);
    expect(past.text).toContain("no records in that range");
  });

  test("a section stops at its size limit even with records to spare", async () => {
    const dir = await makeTempDir("omp-distill-trace-");
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: "01a0ced4-3333-7000-8000-000000000012",
      cwd: "/work/alpha",
      lines: Array.from({ length: 30 }, (_unused, index) =>
        userMessage({ id: `3000000${index.toString(16)}`, parentId: index === 0 ? null : `3000000${(index - 1).toString(16)}` }, "x".repeat(3_000)),
      ),
    });
    const loaded = await loadSession(sessionPath);
    if (!loaded.ok) throw new Error(loaded.reason);
    const bundle = buildBundle({
      projectRoot: "/work/alpha",
      sessionId: loaded.session.header.id,
      sessionFile: sessionPath,
      parent: resolveBranch(loaded.session.entries),
      subagents: [],
    });
    const trace = bundle.traces[0];
    if (!trace) throw new Error("no trace");

    const section = renderTraceSection(trace, OPTIONS, { limit: 30 });
    expect(section.truncated).toBe(true);
    expect(section.text.length).toBeLessThan(MAX_SECTION_CHARS + 1_000);
    expect(section.text).toContain("section limit reached;");
    expect(section.last).toBeLessThan(30);
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

    const [long] = entriesOf([userMessage({ id: "30000001", parentId: null }, "x".repeat(1_250))]);
    const excerpt = excerptFor(long!);
    expect(excerpt.length).toBeLessThan(1_300);
    expect(excerpt).toContain("characters omitted]");
  });

  test("a tool result's content is quoted as evidence even though sections summarise it", async () => {
    const dir = await makeTempDir("omp-distill-trace-");
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: "01a0ced4-4444-7000-8000-000000000013",
      cwd: "/work/alpha",
      lines: [
        assistantMessage({ id: "40000001", parentId: null }, [toolCallPart("call_9", "bash", { command: "ls" })]),
        toolResultMessage({ id: "40000002", parentId: "40000001" }, {
          toolCallId: "call_9",
          toolName: "bash",
          text: `${"a-listed-file-with-a-rather-long-name\n".repeat(20)}tail of the listing`,
        }),
      ],
    });
    const loaded = await loadSession(sessionPath);
    if (!loaded.ok) throw new Error(loaded.reason);
    const branch = resolveBranch(loaded.session.entries);
    const result = branch.find(entry => entry.id === "40000002");
    if (!result) throw new Error("no result record");

    const bundle = buildBundle({
      projectRoot: "/work/alpha",
      sessionId: loaded.session.header.id,
      sessionFile: sessionPath,
      parent: branch,
      subagents: [],
    });
    const trace = bundle.traces[0];
    if (!trace) throw new Error("no trace");
    const section = renderTraceSection(trace, OPTIONS);

    expect(section.text).toContain("[40000002] toolResult bash:");
    expect(section.text).toContain("chars in full, read the trace file for it");
    expect(section.text).not.toContain("tail of the listing");

    expect(excerptFor(result)).toContain("tail of the listing");
  });
});

describe("trace ids", () => {
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
