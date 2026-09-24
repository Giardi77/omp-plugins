import { describe, expect, test } from "bun:test";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import { distillPaths, DEFAULT_CONFIG, setupProject, type DistillPaths } from "../src/config";
import {
  assertHostVersion,
  assertToolSurface,
  compareVersions,
  EVALUATOR_TOOL_NAMES,
  type EvaluatorTool,
  runEvaluation,
  sealedSessionOptions,
  ToolSurfaceMismatch,
} from "../src/evaluator";
import { loadTraceBundle } from "../src/bundle";
import { loadSession, resolveBranch } from "../src/store";
import { buildBundle, type TraceBundle } from "../src/trace";
import { isRecord } from "../src/util";
import { assistantMessage, makeTempDir, textPart, userMessage, writeSessionFixture } from "./fixtures";

const SESSION_ID = "abc12345-1111-7000-8000-000000000050";

async function fixtureBundle(): Promise<{ paths: DistillPaths; bundle: TraceBundle }> {
  const dir = await makeTempDir("omp-distill-evaluator-");
  const paths = distillPaths(`${dir}/project`);
  await setupProject(paths.projectRoot);
  const sessionPath = await writeSessionFixture({
    dir,
    sessionId: SESSION_ID,
    cwd: paths.projectRoot,
    lines: [
      userMessage({ id: "aaaa0001", parentId: null }, "the retry helper sleeps too little"),
      assistantMessage({ id: "aaaa0002", parentId: "aaaa0001" }, [textPart("raised it to 250ms")]),
    ],
  });
  const loaded = await loadSession(sessionPath);
  if (!loaded.ok) throw new Error(loaded.reason);
  return {
    paths,
    bundle: buildBundle({
      projectRoot: paths.projectRoot,
      sessionId: loaded.session.header.id,
      sessionFile: sessionPath,
      parent: resolveBranch(loaded.session.entries),
      subagents: [],
    }),
  };
}

const goodLesson = {
  kind: "skill",
  title: "Wait longer between retries",
  body: "Sleep at least 250ms between retry attempts.",
  target: "retry-helper",
  rationale: "The flake disappeared once the sleep grew.",
  citations: ["abc12345:aaaa0002"],
};

interface ScriptedCall {
  /** Which of the run's tools to call; `propose_lessons` unless named. */
  tool?: string;
  params: unknown;
  /** When set, the call must fail with a message containing this. */
  errorContains?: string;
}

interface Script {
  enabled?: string[];
  calls?: ScriptedCall[];
  promptError?: Error;
  entries?: unknown[];
  /** The settled assistant message, where a failed model call leaves its reason. */
  settled?: { stopReason?: string; errorMessage?: string };
}

/** The fixture's parent trace, and the two calls that make a scripted run a complete one. */
const TRACE = "abc12345";
const readTail: ScriptedCall = { tool: "get_trace", params: { trace: TRACE, from: 1 } };
const finish: ScriptedCall = { tool: "tasks_completed", params: {} };

/** A fake injected SDK whose session plays a scripted transcript. */
function scriptedSdk(script: Script) {
  const created: CreateAgentSessionOptions[] = [];
  const prompted: string[] = [];
  let disposed = 0;

  const session = {
    prompt: async (text: string) => {
      prompted.push(text);
      if (script.promptError) throw script.promptError;
      const options = created[created.length - 1];
      for (const call of script.calls ?? []) {
        const name = call.tool ?? "propose_lessons";
        const tool = options?.customTools?.find(candidate => isRecord(candidate) && candidate.name === name);
        if (!isTool(tool)) throw new Error(`the sealed options carried no ${name} tool`);
        let failure: string | undefined;
        try {
          await tool.execute("call-id", call.params);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (call.errorContains === undefined && failure !== undefined) throw new Error(`unexpected tool error: ${failure}`);
        if (call.errorContains !== undefined && !failure?.includes(call.errorContains)) {
          throw new Error(`expected a tool error containing "${call.errorContains}", got: ${failure ?? "success"}`);
        }
      }
      return true;
    },
    waitForIdle: async () => {},
    getEnabledToolNames: () => script.enabled ?? [...EVALUATOR_TOOL_NAMES],
    getLastAssistantMessage: () => script.settled,
    sessionManager: { getEntries: () => script.entries ?? [] },
    dispose: async () => {
      disposed++;
    },
  };

  const sdk = {
    VERSION: "18.3.0",
    SessionManager: { inMemory: () => ({ memory: true }) as never },
    createAgentSession: async (options: CreateAgentSessionOptions) => {
      created.push(options);
      return { session };
    },
  };

  return { sdk, created, prompted, disposedCount: () => disposed };
}

function isTool(value: unknown): value is EvaluatorTool {
  return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

async function run(script: Script, overrides: { config?: typeof DEFAULT_CONFIG; now?: number } = {}) {
  const { paths, bundle } = await fixtureBundle();
  const fake = scriptedSdk(script);
  const result = await runEvaluation({
    sdk: fake.sdk,
    paths,
    config: overrides.config ?? DEFAULT_CONFIG,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    bundle,
    payload: "# distill payload\ntrace abc12345\n[aaaa0002] assistant: raised it to 250ms\n",
    evaluatorPrompt: "# taste\n",
    modelRegistry: { registry: true } as never,
  });
  return { result, fake, paths };
}

describe("sealing", () => {
  test("the option set is sealed as a value", () => {
    const sessionManager = { memory: true } as never;
    const modelRegistry = { registry: true } as never;
    const tool = { name: "propose_lessons", label: "x", description: "y", parameters: {}, execute: async () => ({ content: [] }) };

    const options = sealedSessionOptions({
      projectRoot: "/work/alpha",
      evaluatorPrompt: "# taste",
      tools: [tool],
      sessionManager,
      modelRegistry,
      timeoutSeconds: 600,
      now: 1_000_000,
    });

    expect(options.cwd).toBe("/work/alpha");
    expect(options.systemPrompt).toEqual(["# taste"]);
    expect(options.restrictToolNames).toBe(true);
    expect(options.toolNames).toEqual(["read", "glob", "grep", "get_trace", "propose_lessons", "tasks_completed"]);
    expect(options.allowRestrictedCustomTools).toBe(true);
    expect(options.disableExtensionDiscovery).toBe(true);
    expect(options.skills).toEqual([]);
    expect(options.rules).toEqual([]);
    expect(options.contextFiles).toEqual([]);
    expect(options.promptTemplates).toEqual([]);
    expect(options.slashCommands).toEqual([]);
    expect(options.enableMCP).toBe(false);
    expect(options.enableLsp).toBe(false);
    expect(options.enableIrc).toBe(false);
    expect(options.hasUI).toBe(false);
    expect(options.autoApprove).toBe(true);
    expect(options.sessionManager).toBe(sessionManager);
    expect(options.modelRegistry).toBe(modelRegistry);
    expect(options.parentTaskPrefix).toBe("distill");
    expect(options.deadline).toBe(1_000_000 + 600_000);
    expect(options.customTools).toEqual([tool]);
  });

  test("the tool surface is compared, not trusted", () => {
    expect(() => assertToolSurface(["read", "glob", "grep", "get_trace", "propose_lessons", "tasks_completed"])).not.toThrow();

    expect(() =>
      assertToolSurface(["read", "glob", "grep", "get_trace", "propose_lessons", "tasks_completed", "write"]),
    ).toThrow(ToolSurfaceMismatch);
    try {
      assertToolSurface(["read", "glob", "write"]);
    } catch (error) {
      const mismatch = error as ToolSurfaceMismatch;
      expect(mismatch.unexpected).toEqual(["write"]);
      expect(mismatch.missing).toEqual(["grep", "get_trace", "propose_lessons", "tasks_completed"]);
      expect(mismatch.message).toContain("does not match the sealed list");
    }
  });

  test("a host older than the sealing options is refused", () => {
    expect(assertHostVersion("18.3.0")).toBe("18.3.0");
    expect(assertHostVersion("17.4.0")).toBe("17.4.0");
    expect(() => assertHostVersion("16.2.12")).toThrow("refusing to run an evaluator that could be unsealed");
    expect(() => assertHostVersion(undefined)).toThrow("refusing to run an evaluator");
    expect(compareVersions("17.4.0", "17.4.0")).toBe(0);
    expect(compareVersions("17.3.9", "17.4.0")).toBe(-1);
    expect(compareVersions("18.0.0", "17.4.0")).toBe(1);
  });
});

describe("a run", () => {
  test("takes the answer from the last propose_lessons call", async () => {
    const { result, fake } = await run({
      calls: [
        readTail,
        { params: { verdict: "first try", lessons: [{ ...goodLesson, body: "first body" }] } },
        { params: { verdict: "second try", lessons: [goodLesson] } },
        finish,
      ],
    });

    expect(result.status).toBe("lessons");
    expect(result.verdict).toBe("second try");
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.lesson.body).toBe("Sleep at least 250ms between retry attempts.");
    expect(result.proposals[0]?.resolved[0]?.excerpt).toBe("assistant: raised it to 250ms");
    expect(result.traceSessionIds).toEqual([SESSION_ID]);
    expect(fake.prompted[0]).toContain("# distill payload");
    expect(fake.disposedCount()).toBe(1);
    expect(fake.created[0]?.systemPrompt).toEqual(["# taste\n"]);
  });

  test("an empty answer is a recorded outcome, not a failure", async () => {
    const { result } = await run({ calls: [readTail, { params: { verdict: "nothing durable here", lessons: [] } }, finish] });
    expect(result.status).toBe("empty");
    expect(result.verdict).toBe("nothing durable here");
    expect(result.proposals).toEqual([]);
  });

  test("a run that never calls the tool is a failure", async () => {
    const { result } = await run({});
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("the evaluator finished without calling propose_lessons");
  });

  test("an answer that stops without tasks_completed is a failure too", async () => {
    // The exit is a call: going quiet after answering is not a finished run (ADR-0017).
    const { result } = await run({
      calls: [readTail, { params: { verdict: "answered, then went quiet", lessons: [goodLesson] } }],
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("the evaluator finished without calling tasks_completed");
    expect(result.proposals).toEqual([]);
  });

  test("tasks_completed refuses while a trace has not been read to its end", async () => {
    const { result } = await run({
      calls: [
        { tool: "get_trace", params: { trace: TRACE, from: 1, to: 1 } },
        { params: { verdict: "read the head, not the tail", lessons: [goodLesson] } },
        {
          tool: "tasks_completed",
          params: {},
          errorContains: "Make sure you went through ALL the session looking for lessons and patterns before calling this tool",
        },
        // The refusal is what sends it back: the tail is one call away, and then the exit holds.
        { tool: "get_trace", params: { trace: TRACE, from: 2 } },
        finish,
      ],
    });

    expect(result.status).toBe("lessons");
    expect(result.verdict).toBe("read the head, not the tail");
    expect(result.proposals).toHaveLength(1);
  });

  test("the tail of every trace is required, not just the parent's", async () => {
    // One evaluation carries the parent and its subagents, so finishing on the parent's tail
    // alone is the shape the gate exists to refuse.
    const dir = await makeTempDir("omp-distill-evaluator-");
    const paths = distillPaths(`${dir}/project`);
    await setupProject(paths.projectRoot);
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: SESSION_ID,
      cwd: paths.projectRoot,
      lines: [
        userMessage({ id: "aaaa0001", parentId: null }, "the retry helper sleeps too little"),
        assistantMessage({ id: "aaaa0002", parentId: "aaaa0001" }, [textPart("raised it to 250ms")]),
      ],
      subagents: [
        { name: "Worker", sessionId: "dddd9999-2222-7000-8000-000000000051", lines: [userMessage({ id: "bbbb0001", parentId: null }, "fix the flake")] },
      ],
    });
    const loaded = await loadTraceBundle({ sessionFile: sessionPath, projectRoot: paths.projectRoot });
    if (!loaded.ok) throw new Error(loaded.reason);
    const fake = scriptedSdk({
      calls: [
        readTail,
        { params: { verdict: "read the parent only", lessons: [] } },
        { tool: "tasks_completed", params: {}, errorContains: "Not read to the end: dddd9999 (1 record)" },
        { tool: "get_trace", params: { trace: "dddd9999", from: 1 } },
        finish,
      ],
    });

    const result = await runEvaluation({
      sdk: fake.sdk,
      paths,
      config: DEFAULT_CONFIG,
      bundle: loaded.bundle,
      payload: "payload",
      evaluatorPrompt: "# taste",
      modelRegistry: {} as never,
    });

    expect(result.status).toBe("empty");
    expect(result.verdict).toBe("read the parent only");
  });

  test("an unresolvable citation comes back as a tool error the model can fix", async () => {
    const { result } = await run({
      calls: [
        readTail,
        {
          params: { verdict: "invented evidence", lessons: [{ ...goodLesson, citations: ["abc12345:deadbeef"] }] },
          errorContains: "does not contain",
        },
        { params: { verdict: "corrected", lessons: [goodLesson] } },
        finish,
      ],
    });

    expect(result.status).toBe("lessons");
    expect(result.verdict).toBe("corrected");
    expect(result.proposals[0]?.resolved).toHaveLength(1);
  });

  test("a failed model call is reported in the provider's own words", async () => {
    const { result } = await run({
      settled: {
        stopReason: "error",
        errorMessage:
          "400 This model's maximum context length is 1048576 tokens.\nHowever, you requested 1507603 tokens (type=invalid_request_error)",
      },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("the evaluator's model call failed");
    expect(result.reason).toContain("maximum context length is 1048576 tokens");
    expect(result.reason).not.toContain("However"); // first line only
  });

  test("a timeout is recorded as a failure and the session is still disposed", async () => {
    const timeout = new Error("the run exceeded its deadline");
    timeout.name = "TimeoutError";
    const { result, fake } = await run({ promptError: timeout });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("exceeded the 600s deadline");
    expect(fake.disposedCount()).toBe(1);
  });

  test("a scan cancelled before a run starts pays for nothing", async () => {
    const { paths, bundle } = await fixtureBundle();
    const fake = scriptedSdk({ calls: [{ params: { verdict: "should never run", lessons: [] } }] });
    const controller = new AbortController();
    controller.abort();

    const result = await runEvaluation({
      sdk: fake.sdk,
      paths,
      config: DEFAULT_CONFIG,
      bundle,
      payload: "payload",
      evaluatorPrompt: "# taste",
      modelRegistry: {} as never,
      signal: controller.signal,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("cancelled");
    expect(fake.created).toEqual([]);
    expect(fake.prompted).toEqual([]);
  });

  test("a deadline that ends the run without a throw is still a timeout", async () => {
    // The host ends a deadline-exceeded stream gracefully, so the run reaches waitForIdle and
    // simply never calls the tool; the elapsed deadline is what makes it a timeout (D14).
    const { result } = await run({}, { config: { ...DEFAULT_CONFIG, timeout_seconds: 1 }, now: Date.now() - 5_000 });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("exceeded the 1s deadline");
  });

  test("the evaluator's reads are reconstructed from its own transcript", async () => {
    const { result } = await run({
      calls: [readTail, { params: { verdict: "read the skills first", lessons: [] } }, finish],
      entries: [
        {
          type: "message",
          id: "1",
          parentId: null,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/work/alpha/.omp/skills/a/SKILL.md" } },
              { type: "toolCall", id: "call_2", name: "grep", arguments: { pattern: "retry", path: "/work/alpha/src" } },
              { type: "toolCall", id: "call_3", name: "glob", arguments: { path: "/work/alpha/.omp/agents" } },
            ],
          },
        },
      ],
    });

    expect(result.reads).toEqual([
      "glob /work/alpha/.omp/agents",
      "grep retry in /work/alpha/src",
      "read /work/alpha/.omp/skills/a/SKILL.md",
    ]);
  });

  test("a tool-surface mismatch stops the scan before any payload", async () => {
    const { paths, bundle } = await fixtureBundle();
    const fake = scriptedSdk({ enabled: [...EVALUATOR_TOOL_NAMES, "write"] });

    await expect(
      runEvaluation({
        sdk: fake.sdk,
        paths,
        config: DEFAULT_CONFIG,
        bundle,
        payload: "payload",
        evaluatorPrompt: "# taste",
        modelRegistry: {} as never,
      }),
    ).rejects.toThrow(ToolSurfaceMismatch);

    expect(fake.prompted).toEqual([]);
    expect(fake.disposedCount()).toBe(1);
  });

  test("an old host never gets as far as building a session", async () => {
    const { paths, bundle } = await fixtureBundle();
    const fake = scriptedSdk({});
    fake.sdk.VERSION = "16.2.12";

    await expect(
      runEvaluation({
        sdk: fake.sdk,
        paths,
        config: DEFAULT_CONFIG,
        bundle,
        payload: "payload",
        evaluatorPrompt: "# taste",
        modelRegistry: {} as never,
      }),
    ).rejects.toThrow("refusing to run an evaluator");

    expect(fake.created).toEqual([]);
  });
});
