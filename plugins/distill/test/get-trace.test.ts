import { describe, expect, test } from "bun:test";
import { loadSession, resolveBranch } from "../src/store";
import { buildBundle, type TraceBundle } from "../src/trace";
import { readTrace } from "../src/evaluator";
import { assistantMessage, makeTempDir, textPart, toolCallPart, toolResultMessage, userMessage, writeSessionFixture } from "./fixtures";

const OPTIONS = { includeThinking: false } as const;

async function traceFixture(): Promise<TraceBundle> {
  const dir = await makeTempDir("omp-distill-get-trace-");
  const sessionPath = await writeSessionFixture({
    dir,
    sessionId: "51d0aaaa-1111-7000-8000-000000000090",
    cwd: "/work/api-client",
    lines: [
      userMessage({ id: "a1000001", parentId: null }, "the CI job keeps failing on the retry test"),
      assistantMessage({ id: "a1000002", parentId: "a1000001" }, [
        textPart("Raising the retry sleep."),
        toolCallPart("call_1", "edit", { path: "src/retry.ts", newString: "await sleep(250)" }),
      ]),
      toolResultMessage({ id: "a1000003", parentId: "a1000002" }, {
        toolCallId: "call_1",
        toolName: "edit",
        text: 'Tool "edit" is blocked by user policy.',
        isError: true,
      }),
      userMessage({ id: "a1000004", parentId: "a1000003" }, "the 100ms sleep is deliberate; the flake is the test's own timer"),
    ],
  });
  const loaded = await loadSession(sessionPath);
  if (!loaded.ok) throw new Error(loaded.reason);
  return buildBundle({
    projectRoot: "/work/api-client",
    sessionId: loaded.session.header.id,
    sessionFile: sessionPath,
    parent: resolveBranch(loaded.session.entries),
    subagents: [],
  });
}

describe("get_trace", () => {
  test("returns a record range with the ids a citation needs", async () => {
    const bundle = await traceFixture();
    const text = await readTrace({ trace: bundle.traces[0]?.id, from: 1, to: 2 }, bundle, OPTIONS);

    expect(text).toContain("records 1..4");
    expect(text).toContain("[a1000001] user: the CI job keeps failing on the retry test");
    expect(text).toContain('[a1000002] assistant toolCall edit: {"path":"src/retry.ts"');
    expect(text).not.toContain("[a1000004]");
    expect(text).toContain("section: records 1..2 of 4");
    expect(text).toContain('next: get_trace trace="51d0aaaa" from=3');
  });

  test("finds records by pattern", async () => {
    const bundle = await traceFixture();
    const text = await readTrace({ trace: bundle.traces[0]?.id, pattern: "blocked by user policy" }, bundle, OPTIONS);

    expect(text).toContain("[a1000003] toolResult edit error");
    expect(text).toContain("1 match(es)");
    expect(text).not.toContain("[a1000001]");
  });

  test("runs a jq filter over the trace's own records, which beats a range", async () => {
    if (!Bun.which("jq")) return;
    const bundle = await traceFixture();
    const text = await readTrace(
      {
        trace: bundle.traces[0]?.id,
        jq: '.message.content[]? | select(.type=="toolCall") | .name',
        from: 1,
        to: 1,
      },
      bundle,
      OPTIONS,
    );

    expect(text).toContain('jq .message.content[]? | select(.type=="toolCall") | .name');
    expect(text).toContain('"edit"');
    // jq wins: no rendered section came back.
    expect(text).not.toContain("section: records");
  });

  test("an unknown trace names the ones that exist rather than failing the run", async () => {
    const bundle = await traceFixture();
    const text = await readTrace({ trace: "nope" }, bundle, OPTIONS);

    expect(text).toContain('No trace "nope"');
    expect(text).toContain("51d0aaaa (parent session)");
  });
});
