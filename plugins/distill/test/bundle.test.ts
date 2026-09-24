import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { loadTraceBundle, planEvaluations } from "../src/bundle";
import { renderPayload } from "../src/trace";
import {
  assistantMessage,
  makeTempDir,
  textPart,
  titleSlot,
  userMessage,
  writeSessionFixture,
} from "./fixtures";

const PARENT_ID = "11112222-3333-7000-8000-000000000070";
const WORKER_ID = "11112222-4444-7000-8000-000000000071";

describe("trace bundles", () => {
  test("one payload carries the parent and every subagent trace", async () => {
    const dir = await makeTempDir("omp-distill-bundle-");
    const projectRoot = "/work/alpha";
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: PARENT_ID,
      cwd: projectRoot,
      lines: [userMessage({ id: "60000001", parentId: null }, "delegate the retry fix")],
      subagents: [
        {
          name: "Worker",
          sessionId: WORKER_ID,
          lines: [
            userMessage({ id: "60000002", parentId: null }, "fix the flake"),
            assistantMessage({ id: "60000003", parentId: "60000002" }, [textPart("raised the sleep to 250ms")]),
          ],
        },
      ],
    });

    const result = await loadTraceBundle({ sessionFile: sessionPath, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.warnings).toEqual([]);
    expect(result.bundle.traces.map(trace => trace.label)).toEqual(["parent session", "subagent Worker"]);
    expect(result.bundle.traces.map(trace => trace.sessionId)).toEqual([PARENT_ID, WORKER_ID]);

    const payload = renderPayload(result.bundle, { includeThinking: false });
    expect(payload).toContain("traces: 2");
    expect(payload).toContain("## trace 11112222 — parent session");
    expect(payload).toContain("## trace 111122224444 — subagent Worker");
    expect(payload).toContain("[60000003] assistant: raised the sleep to 250ms");
  });

  test("a subagent file that cannot be read is named and skipped, never fatal", async () => {
    const dir = await makeTempDir("omp-distill-bundle-");
    const projectRoot = "/work/alpha";
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: "11112222-5555-7000-8000-000000000072",
      cwd: projectRoot,
      lines: [userMessage({ id: "70000001", parentId: null }, "one trace")],
    });
    const artifacts = sessionPath.slice(0, -".jsonl".length);
    await Bun.write(path.join(artifacts, "Broken.jsonl"), `${titleSlot()}\n${JSON.stringify({ type: "custom" })}\n`);

    const result = await loadTraceBundle({ sessionFile: sessionPath, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.traces).toHaveLength(1);
    expect(result.warnings).toEqual(["Broken.jsonl: no session header found"]);
  });

  test("a session that fits goes in one payload, and one that does not is split by trace", async () => {
    const dir = await makeTempDir("omp-distill-bundle-");
    const projectRoot = "/work/alpha";
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: "11112222-6666-7000-8000-000000000073",
      cwd: projectRoot,
      lines: [userMessage({ id: "80000001", parentId: null }, "x".repeat(4_000))],
      subagents: [{ name: "Worker", sessionId: "11112222-7777-7000-8000-000000000074", lines: [userMessage({ id: "80000002", parentId: null }, "y".repeat(4_000))] }],
    });

    const result = await loadTraceBundle({ sessionFile: sessionPath, projectRoot });
    if (!result.ok) throw new Error(result.reason);
    const options = { includeThinking: false };

    const roomy = planEvaluations(result.bundle, 1_000_000, options);
    expect(roomy.groups).toHaveLength(1);
    expect(roomy.oversized).toEqual([]);

    const tight = planEvaluations(result.bundle, 6_000, options);
    expect(tight.groups).toHaveLength(2);
    expect(tight.groups.map(group => group.traces.length)).toEqual([1, 1]);
    expect(tight.groups[0]?.traces[0]?.sessionId).toBe("11112222-6666-7000-8000-000000000073");
    expect(tight.oversized).toEqual([]);

    // Two traces that fit together share a run: the split costs the fewest runs the budget allows.
    const pair = planEvaluations(result.bundle, 9_000, options);
    expect(pair.groups).toHaveLength(1);
    expect(pair.groups[0]?.traces).toHaveLength(2);

    // A single trace past the budget fits nowhere: named, never truncated.
    const squeezed = planEvaluations(result.bundle, 1_000, options);
    expect(squeezed.groups).toEqual([]);
    expect(squeezed.oversized).toHaveLength(2);
    expect(squeezed.oversized[0]?.chars).toBeGreaterThan(1_000);
  });

  test("an unreadable parent session is a refusal with a reason", async () => {
    const dir = await makeTempDir("omp-distill-bundle-");
    const result = await loadTraceBundle({ sessionFile: path.join(dir, "missing.jsonl"), projectRoot: "/work/alpha" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unreadable session file");
  });
});
