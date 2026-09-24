import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import type { CreateAgentSessionOptions, ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { distillPaths, setupProject } from "../src/config";
import { EVALUATOR_TOOL_NAMES, type EvaluatorTool } from "../src/evaluator";
import distillExtension from "../src/index";
import { evaluationRecord, listLessons, readLedger } from "../src/lessons";
import { resolveStore } from "../src/store";
import { isRecord } from "../src/util";
import { assistantMessage, makeTempDir, textPart, userMessage, writeSessionFixture } from "./fixtures";

const SESSION_ID = "aaaa1111-2222-7000-8000-000000000060";
const RECORD_ID = "50000001";

type RegisteredCommand = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type Handler = (event: unknown, ctx: ExtensionCommandContext) => unknown;

interface Harness {
  api: ExtensionAPI;
  commands: Record<string, RegisteredCommand>;
  sessionStart: Handler[];
  labels: string[];
  /** Every evaluator session the scan asked for, in order. */
  created: CreateAgentSessionOptions[];
}

function harness(options: { evaluate?: boolean; agentDir?: string } = {}): Harness {
  const commands: Record<string, RegisteredCommand> = {};
  const sessionStart: Handler[] = [];
  const labels: string[] = [];
  const created: CreateAgentSessionOptions[] = [];

  const pi = {
    setLabel: (label: string) => labels.push(label),
    registerCommand: (name: string, options: RegisteredCommand) => {
      commands[name] = options;
    },
    on: (event: string, handler: Handler) => {
      if (event === "session_start") sessionStart.push(handler);
    },
    pi: {
      VERSION: "18.3.0",
      getAgentDir: () => options.agentDir ?? "/Users/giardi/.omp/agent",
      SessionManager: { inMemory: () => ({ memory: true }) },
      createAgentSession: async (createOptions: CreateAgentSessionOptions) => {
        created.push(createOptions);
        const tools = {
          trace: createOptions.customTools?.find(candidate => isRecord(candidate) && candidate.name === "get_trace"),
          propose: createOptions.customTools?.find(candidate => isRecord(candidate) && candidate.name === "propose_lessons"),
        };
        return {
          session: {
            prompt: async (text: string) => {
              lastPayload = text;
              if (options.evaluate && isEvaluatorTool(tools.trace) && isEvaluatorTool(tools.propose)) {
                lastRead = await scriptedAnswer({ trace: tools.trace, propose: tools.propose }, text);
              }
              return true;
            },
            waitForIdle: async () => {},
            getEnabledToolNames: () => [...EVALUATOR_TOOL_NAMES],
            sessionManager: { getEntries: () => [] },
            dispose: async () => {},
          },
        };
      },
    },
  };

  return { api: pi as unknown as ExtensionAPI, commands, sessionStart, labels, created };
}

/**
 * What a real evaluator does now: read the inventory, fetch a section with get_trace, and cite a
 * record it actually read. Anything less would not exercise the reading path at all.
 */
async function scriptedAnswer(tools: { trace: EvaluatorTool; propose: EvaluatorTool }, inventory: string) {
  const traceId = /## trace ([0-9a-z-]+)/.exec(inventory)?.[1] ?? "";
  const read = await tools.trace.execute("call-read", { trace: traceId, from: 1, to: 40 });
  const section = read.content[0]?.text ?? "";
  const recordId = /\[([0-9a-f]{8})\]/.exec(section)?.[1] ?? "";
  await tools.propose.execute("call-propose", {
    verdict: "one lesson from the fixture",
    lessons: [
      {
        kind: "skill",
        title: "Retry backoff is coarse",
        body: "Sleep at least 250ms between retry attempts.",
        target: "retry-backoff",
        rationale: "The fixture session shows the flake disappearing once the sleep grew.",
        citations: [`${traceId}:${recordId}`],
      },
    ],
  });
  return { traceId, recordId, section };
}

function isEvaluatorTool(value: unknown): value is EvaluatorTool {
  return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

// The payload the command handed the evaluator, captured through `prompt`, plus what the
// scripted evaluator read out of it.
let lastPayload = "";
let lastRead: { traceId: string; recordId: string; section: string } | undefined;

interface FakeModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

interface FakeContextOptions {
  cwd: string;
  mode: "tui" | "rpc" | "print" | "json";
  sessionDir: string;
  select?: (title: string, options: Array<string | { label: string }>) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
  models?: FakeModel[];
}

interface Notified {
  message: string;
  type?: string;
}

function fakeContext(options: FakeContextOptions): { ctx: ExtensionCommandContext; notifications: Notified[] } {
  const notifications: Notified[] = [];
  const ctx = {
    cwd: options.cwd,
    mode: options.mode,
    hasUI: options.mode === "tui" || options.mode === "rpc",
    sessionManager: { getSessionDir: () => options.sessionDir },
    modelRegistry: { registry: true },
    model: (options.models ?? [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }])[0],
    models: (() => {
      const models: FakeModel[] = options.models ?? [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }];
      const specOf = (model: FakeModel) => `${model.provider}/${model.id}`;
      return {
        current: () => models[0],
        list: () => models,
        resolve: (spec: string) => models.find(model => specOf(model) === spec),
      };
    })(),
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
      select: options.select ?? (async () => undefined),
      confirm: options.confirm ?? (async () => false),
      editor: async (title: string, prefill?: string) => {
        notifications.push({ message: `editor:${title}:${prefill?.length ?? 0}` });
        return undefined;
      },
      custom: async () => undefined,
    },
  };
  return { ctx: ctx as unknown as ExtensionCommandContext, notifications };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

afterEach(() => {
  lastPayload = "";
});

async function projectWithSession(): Promise<{ project: string; sessionDir: string; agentDir: string }> {
  const root = await makeTempDir("omp-distill-command-");
  // The project sits beside the fake home: a `.omp/` above it would otherwise be found by
  // the project-root walk-up (in a real session, home itself is excluded).
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  const sessionDir = resolveStore(project, { agentDir: path.join(home, ".omp", "agent"), home }).projectDir;
  await writeSessionFixture({
    dir: sessionDir,
    sessionId: SESSION_ID,
    cwd: project,
    lines: [
      userMessage({ id: RECORD_ID, parentId: null }, "the retry helper sleeps too little"),
      assistantMessage({ id: "50000002", parentId: RECORD_ID }, [textPart("raised it to 250ms")]),
    ],
  });
  return { project, sessionDir, agentDir: path.join(home, ".omp", "agent") };
}

describe("the distill command", () => {
  test("registers one command, a label, a session-start handler and its completions", () => {
    const { api, commands, sessionStart, labels } = harness();
    distillExtension(api);

    expect(labels).toEqual(["Distill"]);
    expect(sessionStart).toHaveLength(1);
    expect(commands.distill?.description).toContain("scan");

    const command = commands.distill!;
    const names = (command.getArgumentCompletions?.("") ?? []) as Array<{ label: string }>;
    expect(names.map(entry => entry.label)).toEqual(["setup", "enable", "disable", "status", "scan", "review", "purge"]);
    const flags = (command.getArgumentCompletions?.("scan --") ?? []) as Array<{ label: string }>;
    expect(flags.map(entry => entry.label)).toEqual(["--limit", "--session", "--dry-run"]);
    expect(command.getArgumentCompletions?.("nonsense")).toBeNull();
  });

  test("a project with no config file is reported, not scanned", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const { api, commands } = harness({ agentDir });
    distillExtension(api);

    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });
    const output = await captureStdout(() => commands.distill!.handler("status", ctx));

    expect(output).toContain("not active");
  });

  test("setup picks the evaluator model by provider, so no whole family hides behind a cap", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const paths = distillPaths(project);

    const cursor = Array.from({ length: 30 }, (_unused, index) => ({
      provider: "cursor",
      id: `claude-${index}`,
      name: `Cursor Claude ${index}`,
    }));
    const calls: Array<{ title: string; options: string[] }> = [];
    const scripting = fakeContext({
      cwd: project,
      mode: "tui",
      sessionDir,
      models: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }, ...cursor],
      select: async (title, options) => {
        calls.push({ title, options: options.map(option => (typeof option === "string" ? option : option.label)) });
        if (title.includes("provider")) return "cursor — 30 models";
        if (title.includes("cursor")) return "cursor/claude-29";
        return "high";
      },
      confirm: async () => true,
    });

    await captureStdout(() => commands.distill!.handler("setup", scripting.ctx));

    expect(calls[0]?.options).toEqual([
      "deepseek — 1 model (this session)",
      "cursor — 30 models",
    ]);
    // Every model of the chosen provider is offered; the earlier cap cut at 25 and hid the rest.
    expect(calls[1]?.title).toContain("cursor");
    expect(calls[1]?.options).toHaveLength(30);
    expect(calls[1]?.options.at(-1)).toBe("cursor/claude-29");

    const raw = YAML.parse(await Bun.file(paths.configPath).text()) as Record<string, unknown>;
    expect(raw.model).toBe("cursor/claude-29");
  });

  test("a single-model provider is chosen without a second dialog", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const paths = distillPaths(project);

    const calls: Array<{ title: string; options: string[] }> = [];
    const scripting = fakeContext({
      cwd: project,
      mode: "tui",
      sessionDir,
      models: [
        { provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
        { provider: "cursor", id: "claude-4.6-sonnet", name: "Cursor Claude 4.6" },
      ],
      select: async (title, options) => {
        calls.push({ title, options: options.map(option => (typeof option === "string" ? option : option.label)) });
        return title.includes("provider") ? "deepseek — 1 model (this session)" : "high";
      },
      confirm: async () => true,
    });

    await captureStdout(() => commands.distill!.handler("setup", scripting.ctx));

    expect(calls[0]?.title).toContain("provider");
    // One model in the chosen provider: no second dialog, and the model is the config's.
    expect(calls.filter(call => call.title.includes("Evaluator model — deepseek"))).toEqual([]);
    expect(calls[1]?.title).toContain("thinking level");
    expect((YAML.parse(await Bun.file(paths.configPath).text()) as Record<string, unknown>).model).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  test("setup activates the project, and enable/disable toggle it", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const paths = distillPaths(project);

    const headless = fakeContext({ cwd: project, mode: "print", sessionDir });
    const setupOutput = await captureStdout(() =>
      commands.distill!.handler("setup --model anthropic/claude-sonnet --thinking high", headless.ctx),
    );
    expect(setupOutput).toContain("config.yaml");
    expect(setupOutput).toContain("thinking: high");

    const raw = YAML.parse(await Bun.file(paths.configPath).text()) as Record<string, unknown>;
    expect(raw.model).toBe("anthropic/claude-sonnet");
    expect(raw.thinking).toBe("high");
    expect(raw.redact).toBeUndefined();
    expect(await Bun.file(paths.evaluatorPath).text()).toContain("# What this project learns from its sessions");

    await captureStdout(() => commands.distill!.handler("disable", headless.ctx));
    const disabled = await captureStdout(() => commands.distill!.handler("status", headless.ctx));
    expect(disabled).toContain("distill — disabled");
    expect(disabled).toContain("sessions eligible for a scan: 1");

    await captureStdout(() => commands.distill!.handler("enable", headless.ctx));
    const enabled = await captureStdout(() => commands.distill!.handler("status", headless.ctx));
    expect(enabled).toContain("distill — enabled");
    expect(enabled).toContain("last evaluation: none yet");
  });

  test("a scan evaluates the newest eligible session and records the proposal", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);

    const { api, commands } = harness({ evaluate: true, agentDir });
    distillExtension(api);
    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });

    const output = await captureStdout(() => commands.distill!.handler("scan --limit 1", ctx));

    expect(output).toContain("1 lesson(s) proposed");
    expect(output).toContain("one lesson from the fixture");

    const lessons = await listLessons(paths);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.state).toBe("proposed");
    expect(lessons[0]?.target).toBe("retry-backoff");
    expect(lessons[0]?.citations[0]?.citation).toBe(`aaaa1111:${lastRead?.recordId ?? RECORD_ID}`);
    expect(lastRead?.traceId).toBe("aaaa1111");
    expect(lastRead?.section).toContain("the retry helper sleeps too little");

    const ledger = await readLedger(paths);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "evaluation",
      sessionId: SESSION_ID,
      outcome: "lessons",
      verdict: "one lesson from the fixture",
    });
    expect(lastPayload).toContain("# distill payload");
  });

  test("a session with several traces is one run, and its records are read by section", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);

    const body = "the operator corrected the retry backoff, and the correction stuck. ".repeat(70);
    const workerLines = Array.from({ length: 8 }, (_unused, index) => {
      const id = `6100000${index}`;
      const parentId = index === 0 ? null : `6100000${index - 1}`;
      return index % 2 === 0
        ? userMessage({ id, parentId }, body)
        : assistantMessage({ id, parentId }, [textPart(body)]);
    });
    await writeSessionFixture({
      dir: sessionDir,
      sessionId: SESSION_ID,
      cwd: project,
      lines: [
        userMessage({ id: RECORD_ID, parentId: null }, body),
        assistantMessage({ id: "50000002", parentId: RECORD_ID }, [textPart(body)]),
      ],
      subagents: [{ name: "Worker", sessionId: "aaaa1111-3333-7000-8000-000000000061", lines: workerLines }],
    });

    const { api, commands, created } = harness({ evaluate: true, agentDir });
    distillExtension(api);
    const { ctx } = fakeContext({
      cwd: project,
      mode: "print",
      sessionDir,
      models: [{ provider: "deepseek", id: "tiny", name: "Tiny", contextWindow: 1 }],
    });

    const output = await captureStdout(() => commands.distill!.handler("scan --limit 1", ctx));

    // One run for the session, whatever its size: the payload is the inventory.
    expect(created).toHaveLength(1);
    expect(lastPayload?.match(/## trace /g)).toHaveLength(2);
    expect(lastPayload).toContain("records 1..8");
    expect(output).toContain("1 lesson(s) proposed");

    // And the citation came from a section the scripted evaluator actually read.
    expect(lastRead?.traceId).toBe("aaaa1111");
    const ledger = await readLedger(paths);
    const evaluations = ledger.filter(record => record.kind === "evaluation");
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.kind === "evaluation" ? evaluations[0].traceSessionIds : []).toEqual([
      "aaaa1111-2222-7000-8000-000000000060",
      "aaaa1111-3333-7000-8000-000000000061",
    ]);
  });

  test("a retry's inventory carries only the traces still open", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);

    await writeSessionFixture({
      dir: sessionDir,
      sessionId: SESSION_ID,
      cwd: project,
      lines: [
        userMessage({ id: RECORD_ID, parentId: null }, "the retry helper sleeps too little"),
        assistantMessage({ id: "50000002", parentId: RECORD_ID }, [textPart("raised it to 250ms")]),
      ],
      subagents: [
        {
          name: "Worker",
          sessionId: "aaaa1111-4444-7000-8000-000000000062",
          lines: [userMessage({ id: "60000001", parentId: null }, "check the sleep")],
        },
      ],
    });

    // An earlier evaluation covered the parent trace only — a partial scan, or a subagent trace
    // written after one. The session is eligible again, for whatever is still open.
    await Bun.write(
      paths.decisionsPath,
      `${JSON.stringify(
        evaluationRecord({
          sessionId: SESSION_ID,
          sessionFile: path.join(sessionDir, "seed.jsonl"),
          traceSessionIds: [SESSION_ID],
          outcome: "lessons",
          verdict: "the parent only",
          promptSha256: "seed",
        }),
      )}\n`,
    );

    const { api, commands, created } = harness({ evaluate: true, agentDir });
    distillExtension(api);
    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });

    const output = await captureStdout(() => commands.distill!.handler("scan --limit 1", ctx));

    expect(created).toHaveLength(1);
    expect(output).toContain("1 trace(s), 1 already evaluated");
    expect(lastPayload?.match(/## trace /g)).toHaveLength(1);
    expect(lastPayload).toContain("## trace aaaa11114444 — subagent Worker");
    // No block for the covered parent trace (its id still names the session and the artifact
    // directory the worker's transcript lives in).
    expect(lastPayload).not.toContain("## trace aaaa1111 — parent session");

    const ledger = await readLedger(paths);
    expect(ledger.filter(record => record.kind === "evaluation")).toHaveLength(2);
  });

  test("a dry run prints the payload and writes nothing", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);

    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const { ctx, notifications } = fakeContext({ cwd: project, mode: "print", sessionDir });

    const output = await captureStdout(() => commands.distill!.handler("scan --dry-run", ctx));

    expect(output).toContain("# distill payload");
    expect(output).toContain("records 1..");
    expect(output).toContain(`session ${SESSION_ID}`);
    // The dry run shows what a scan sends: the inventory, not the records.
    expect(output).not.toContain("the retry helper sleeps too little");
    expect(notifications).toEqual([]);
    expect(await listLessons(paths)).toEqual([]);
    expect(await readLedger(paths)).toEqual([]);
  });

  test("a scan with nothing eligible says so", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    await setupProject(project);
    const { api, commands } = harness({ evaluate: true, agentDir });
    distillExtension(api);

    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });
    const fresh = await captureStdout(() => commands.distill!.handler("scan", ctx));
    expect(fresh).toContain("1 lesson(s) proposed");

    const again = await captureStdout(() => commands.distill!.handler("scan --limit 1", ctx));
    expect(again).toContain("No unevaluated sessions");
  });

  test("review in a session without a window reports where the lessons wait", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);
    await Bun.write(
      path.join(paths.lessonsDir, "abc123.json"),
      JSON.stringify({
        id: "abc123",
        state: "proposed",
        kind: "skill",
        title: "t",
        body: "b",
        target: "retry-helper",
        rationale: "r",
        citations: [],
        createdAt: "2026-09-24T00:00:00.000Z",
        provenance: { sessionId: SESSION_ID, traceSessionIds: [], contractVersion: 1, promptSha256: "x" },
      }),
    );

    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });
    const output = await captureStdout(() => commands.distill!.handler("review", ctx));
    expect(output).toContain("needs the terminal");
  });

  test("purge deletes the records, names what it left alone, and re-opens the session", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);

    // One lesson already approved into a skill file, so purge has something to leave alone.
    await Bun.write(
      path.join(paths.lessonsDir, "abc123.json"),
      JSON.stringify({
        id: "abc123",
        state: "approved",
        kind: "skill",
        title: "t",
        body: "b",
        target: "retry-helper",
        rationale: "r",
        citations: [],
        createdAt: "2026-09-24T00:00:00.000Z",
        written: [".omp/skills/retry-helper/SKILL.md"],
        provenance: { sessionId: SESSION_ID, traceSessionIds: [], contractVersion: 1, promptSha256: "x" },
      }),
    );

    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });

    const output = await captureStdout(() => commands.distill!.handler("purge --yes", ctx));
    expect(output).toContain("Purged 1 lesson(s)");
    expect(output).toContain("Left alone (purge does not unwrite files): .omp/skills/retry-helper/SKILL.md");
    expect(await listLessons(paths)).toEqual([]);
  });

  test("purge without confirmation explains itself instead of deleting", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);
    const { api, commands } = harness({ agentDir });
    distillExtension(api);

    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });
    const output = await captureStdout(() => commands.distill!.handler("purge", ctx));
    expect(output).toContain("Purge cancelled");
    expect(await readLedger(paths)).toEqual([]);
  });

  test("an unknown subcommand prints the usage", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const { ctx } = fakeContext({ cwd: project, mode: "print", sessionDir });

    const output = await captureStdout(() => commands.distill!.handler("frobnicate", ctx));
    expect(output).toContain('Unknown subcommand "frobnicate"');
    expect(output).toContain("/distill scan [--limit <n>]");
  });
});

describe("the session-start notice", () => {
  test("fires once for a project with proposed lessons, and only where a UI can show it", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);
    await Bun.write(
      path.join(paths.lessonsDir, "abc123.json"),
      JSON.stringify({
        id: "abc123",
        state: "proposed",
        kind: "skill",
        title: "t",
        body: "b",
        target: "retry-helper",
        rationale: "r",
        citations: [],
        createdAt: "2026-09-24T00:00:00.000Z",
        provenance: { sessionId: SESSION_ID, traceSessionIds: [], contractVersion: 1, promptSha256: "x" },
      }),
    );

    const { api, sessionStart } = harness({ agentDir });
    distillExtension(api);

    const tui = fakeContext({ cwd: project, mode: "tui", sessionDir });
    await sessionStart[0]?.({ type: "session_start" }, tui.ctx);
    expect(tui.notifications.map(entry => entry.message)).toEqual([
      "1 proposed lesson(s) await review — /distill review",
    ]);

    const print = fakeContext({ cwd: project, mode: "print", sessionDir });
    await sessionStart[0]?.({ type: "session_start" }, print.ctx);
    expect(print.notifications).toEqual([]);
  });

  test("stays silent in a project that never activated distill", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const { api, sessionStart } = harness({ agentDir });
    distillExtension(api);

    const tui = fakeContext({ cwd: project, mode: "tui", sessionDir });
    await sessionStart[0]?.({ type: "session_start" }, tui.ctx);
    expect(tui.notifications).toEqual([]);
  });
});
