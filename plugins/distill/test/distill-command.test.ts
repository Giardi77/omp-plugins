import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import type { CreateAgentSessionOptions, ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { distillPaths, setupProject } from "../src/config";
import { EVALUATOR_TOOL_NAMES, type ProposeLessonsTool } from "../src/evaluator";
import distillExtension from "../src/index";
import { listLessons, readLedger } from "../src/lessons";
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
}

function harness(options: { evaluate?: boolean; agentDir?: string } = {}): Harness {
  const commands: Record<string, RegisteredCommand> = {};
  const sessionStart: Handler[] = [];
  const labels: string[] = [];

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
        const tool = createOptions.customTools?.[0];
        return {
          session: {
            prompt: async (text: string) => {
              lastPayload = text;
              if (options.evaluate && isProposeTool(tool)) await tool.execute("call-id", submissionFor(text));
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

  return { api: pi as unknown as ExtensionAPI, commands, sessionStart, labels };
}

function submissionFor(payload: string) {
  const traceId = /## trace ([0-9a-z-]+)/.exec(payload)?.[1] ?? "";
  const recordId = /\[([0-9a-f]{8})\]/.exec(payload)?.[1] ?? "";
  return {
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
  };
}

function isProposeTool(value: unknown): value is ProposeLessonsTool {
  return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

// The payload the command handed the evaluator, captured through `prompt`.
let lastPayload = "";

interface FakeContextOptions {
  cwd: string;
  mode: "tui" | "rpc" | "print" | "json";
  sessionDir: string;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
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
    models: {
      current: () => ({ provider: "anthropic", id: "claude-sonnet" }),
      list: () => [{ provider: "anthropic", id: "claude-sonnet" }],
      resolve: (spec: string) => ({ provider: spec.split("/")[0] ?? "anthropic", id: spec.split("/")[1] ?? spec }),
    },
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
    expect(lessons[0]?.citations[0]?.citation).toBe(`aaaa1111:${RECORD_ID}`);

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

  test("a dry run prints the payload and writes nothing", async () => {
    const { project, sessionDir, agentDir } = await projectWithSession();
    const paths = distillPaths(project);
    await setupProject(project);

    const { api, commands } = harness({ agentDir });
    distillExtension(api);
    const { ctx, notifications } = fakeContext({ cwd: project, mode: "print", sessionDir });

    const output = await captureStdout(() => commands.distill!.handler("scan --dry-run", ctx));

    expect(output).toContain("# distill payload");
    expect(output).toContain(`[${RECORD_ID}] user: the retry helper sleeps too little`);
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
