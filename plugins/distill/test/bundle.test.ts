import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { loadTraceBundle } from "../src/bundle";
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

  test("an unreadable parent session is a refusal with a reason", async () => {
    const dir = await makeTempDir("omp-distill-bundle-");
    const result = await loadTraceBundle({ sessionFile: path.join(dir, "missing.jsonl"), projectRoot: "/work/alpha" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unreadable session file");
  });
});
