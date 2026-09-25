import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { DistillPaths } from "./config";
import type { DistillConfig } from "./config";
import {
  GET_TRACE_DESCRIPTION,
  GET_TRACE_PARAMETERS,
  GET_TRACE_TOOL,
  parseAnswer,
  PROPOSE_LESSONS_DESCRIPTION,
  PROPOSE_LESSONS_PARAMETERS,
  PROPOSE_LESSONS_TOOL,
  resolveCitations,
  TASKS_COMPLETED_DESCRIPTION,
  TASKS_COMPLETED_PARAMETERS,
  TASKS_COMPLETED_TOOL,
} from "./contract";
import type { ProposalInput } from "./lessons";
import { isRecord, messageOf } from "./util";
import { runJq } from "./jq";
import { capText, renderTraceSection, type TraceBundle, type TraceRenderOptions } from "./trace";

/**
 * The evaluator: a second, sealed agent session inside the host process, built from
 * `pi.pi.createAgentSession` — never a direct import, which would resolve to the
 * marketplace's copy of the SDK rather than the running host's (ADR-0007).
 *
 * Sealing is asserted, not trusted. A host that does not honour an option degrades
 * silently — `toolNames: []` means *every* built-in tool where `restrictToolNames` is
 * unsupported, and an unhonoured `allowRestrictedCustomTools` drops the submission tool
 * without a word — so the mounted surface is compared against the declared list before any
 * payload is sent, and the host's SDK version is gated before the session is built.
 */

export const MIN_HOST_SDK_VERSION = "17.4.0";

/** The model type the SDK's own options expect; named here so callers need no extra import. */
export type EvaluatorModel = NonNullable<CreateAgentSessionOptions["model"]>;
export type EvaluatorSessionManager = NonNullable<CreateAgentSessionOptions["sessionManager"]>;
export type EvaluatorModelRegistry = NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
export type EvaluatorSettings = NonNullable<CreateAgentSessionOptions["settings"]>;

export const EVALUATOR_TOOL_NAMES: readonly string[] = [
  "read",
  "glob",
  "grep",
  GET_TRACE_TOOL,
  PROPOSE_LESSONS_TOOL,
  TASKS_COMPLETED_TOOL,
];

export class ToolSurfaceMismatch extends Error {
  readonly unexpected: string[];
  readonly missing: string[];

  constructor(unexpected: string[], missing: string[]) {
    const parts: string[] = [];
    if (unexpected.length > 0) parts.push(`unexpected: ${unexpected.join(", ")}`);
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    super(`The evaluator's tool surface does not match the sealed list (${parts.join("; ")}).`);
    this.name = "ToolSurfaceMismatch";
    this.unexpected = unexpected;
    this.missing = missing;
  }
}

export function assertToolSurface(
  enabled: readonly string[],
  declared: readonly string[] = EVALUATOR_TOOL_NAMES,
): void {
  const wanted = new Set(declared);
  const actual = new Set(enabled);
  const unexpected = enabled.filter(name => !wanted.has(name));
  const missing = declared.filter(name => !actual.has(name));
  if (unexpected.length > 0 || missing.length > 0) throw new ToolSurfaceMismatch(unexpected, missing);
}

/** Version gate: the sealing options arrive in 17.4.0; below it, refuse to scan at all. */
export function assertHostVersion(version: string | undefined): string {
  if (!version || compareVersions(version, MIN_HOST_SDK_VERSION) < 0) {
    throw new Error(
      `distill needs omp's SDK at ${MIN_HOST_SDK_VERSION} or newer (this host reports ${version ?? "an unknown version"}); refusing to run an evaluator that could be unsealed.`,
    );
  }
  return version;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split("-")[0]?.split(".").map(part => Number.parseInt(part, 10) || 0) ?? [];
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** The minimal session surface the evaluator uses; `AgentSession` satisfies it. */
export interface EvaluatorSessionLike {
  prompt(text: string): Promise<unknown>;
  waitForIdle(): Promise<void>;
  getEnabledToolNames(): string[];
  sessionManager: { getEntries(): unknown[] };
  /** The settled assistant message: the only place a failed model call leaves a reason. */
  getLastAssistantMessage?(): { stopReason?: string; errorMessage?: string } | undefined;
  dispose(): Promise<void>;
  /** Ends the run early; used when `/distill purge` requests cancellation. */
  abort?(): void;
}

/** The slice of the SDK's `SettingsOptions` the evaluator uses. */
export interface EvaluatorSettingsOptions {
  cwd?: string;
  agentDir?: string;
  overrides?: Record<string, unknown>;
}

/**
 * The process-global capability gates. Every session creation calls the host's
 * `initializeWithSettings`, which repoints the process's capability settings at the instance it was
 * handed and rebuilds these three from it — so an evaluator holding a project-less instance would
 * otherwise drop the project's view of them for the *main* session's next capability load. Carried
 * across deliberately: they gate what exists (providers, extensions), not what a session is told.
 */
const CAPABILITY_SETTING_KEYS = ["disabledProviders", "enabledProviders", "disabledExtensions"] as const;

/** The injected SDK surface; `pi.pi` satisfies it. */
export interface EvaluatorSdkLike {
  VERSION: string;
  createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: EvaluatorSessionLike }>;
  SessionManager: { inMemory(cwd?: string): EvaluatorSessionManager };
  Settings: {
    loadReadOnly(options: EvaluatorSettingsOptions): Promise<EvaluatorSettings>;
    /**
     * The host's live settings; absent only on a host that never initialized one. `get` is
     * optional on purpose: 18.3.1 removed `Settings.get(path)`, so a host may hand over an
     * instance with no path reader — probed for, never assumed.
     */
    instance?: { get?(path: string): unknown };
  };
}

/**
 * The settings the evaluator session runs under (ADR-0007). Read-only, so a scan neither opens the
 * host's settings storage nor can write the operator's config as a side effect; loaded with the
 * *agent dir* as its cwd, so the project's own `.omp/settings.json` layer is never read. Settings
 * are not inert: `advisor.enabled` attaches a second model that reviews every turn of this session,
 * `workspace.additionalDirectories` widens what the read tools may open, and `tools.approval.*` can
 * gate them. The advisor is forced off as well, because the operator's own layer may enable it.
 *
 * Asserted rather than trusted, like the rest of the seal: a host with no read-only load would
 * otherwise fail a scan with a `TypeError` instead of saying what it is missing.
 */
export async function evaluatorSettings(sdk: EvaluatorSdkLike, agentDir: string): Promise<EvaluatorSettings> {
  if (typeof sdk.Settings?.loadReadOnly !== "function") {
    throw new Error(
      "this host's SDK has no Settings.loadReadOnly, so the evaluator cannot be given read-only settings of its own; distill will not run it against the project's",
    );
  }
  const overrides: Record<string, unknown> = { "advisor.enabled": false };
  // Read through `get` only where the host still has one. 18.3.1 removed `Settings.get(path)`, and
  // nothing is lost by carrying nothing there: the evaluator session is built with
  // `parentTaskPrefix`, which stops it from taking over the process's capability state at all
  // (18.3.1's `bindProcessState`), so the project's view of those gates is never displaced.
  const instance = sdk.Settings.instance;
  if (typeof instance?.get === "function") {
    for (const key of CAPABILITY_SETTING_KEYS) {
      const value = instance.get(key);
      if (Array.isArray(value)) overrides[key] = value;
    }
  }
  return await sdk.Settings.loadReadOnly({ cwd: agentDir, agentDir, overrides });
}

export type ProposeLessonsTool = EvaluatorTool;

export interface EvaluatorTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export interface SealedSessionInput {
  projectRoot: string;
  evaluatorPrompt: string;
  tools: EvaluatorTool[];
  sessionManager: EvaluatorSessionManager;
  modelRegistry: EvaluatorModelRegistry;
  /** The operator's own settings, loaded from the agent dir — never the project's. */
  settings: EvaluatorSettings;
  model?: EvaluatorModel;
  thinkingLevel?: ConfiguredThinkingLevel;
  timeoutSeconds: number;
  now: number;
}

/**
 * The sealed option set (ADR-0007, ADR-0009). Every entry is load-bearing: drop
 * `parentTaskPrefix` and the evaluator claims process globals as the main session; drop
 * `SessionManager.inMemory()` and it writes its own transcript into the store it reads; drop
 * `settings` and the host reads the project's `.omp/settings.json` for this session.
 */
export function sealedSessionOptions(input: SealedSessionInput): CreateAgentSessionOptions {
  return {
    cwd: input.projectRoot,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    settings: input.settings,
    systemPrompt: [input.evaluatorPrompt],
    toolNames: [...EVALUATOR_TOOL_NAMES],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    customTools: [...input.tools],
    disableExtensionDiscovery: true,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    hasUI: false,
    autoApprove: true,
    sessionManager: input.sessionManager,
    parentTaskPrefix: "distill",
    agentId: "distill",
    agentDisplayName: "distill",
    modelRegistry: input.modelRegistry,
    deadline: input.now + input.timeoutSeconds * 1_000,
  };
}

export interface EvaluationRun {
  status: "lessons" | "empty" | "failed";
  reason?: string;
  verdict: string;
  proposals: ProposalInput[];
  /** Files the evaluator opened, reconstructed from its own transcript after the run (D21). */
  reads: string[];
  traceSessionIds: string[];
}

export interface RunEvaluationInput {
  sdk: EvaluatorSdkLike;
  paths: DistillPaths;
  /** The host's agent directory (`pi.pi.getAgentDir()`): where the evaluator's own settings live. */
  agentDir: string;
  config: DistillConfig;
  bundle: TraceBundle;
  payload: string;
  evaluatorPrompt: string;
  modelRegistry: EvaluatorModelRegistry;
  model?: EvaluatorModel;
  now?: number;
  /** Cancellation: `/distill purge` asks a running scan to stop (D19). */
  signal?: AbortSignal;
}

export interface TraceRead {
  /** The section's text, as the tool hands it back. */
  text: string;
  /**
   * The trace this read reached the end of — its last record was rendered — or null when it did
   * not. Asked-for is not seen, so what counts is the section, and a `jq` answer never does: a
   * filter's output is what it kept, not what the evaluator has read (ADR-0017).
   */
  readToEnd: string | null;
}

/**
 * Reads one trace on the evaluator's behalf: a record range, a pattern match, or a jq filter over
 * the trace's own records. Every answer is bounded, and every answer carries the record ids a
 * citation needs. Problems come back as content rather than as a failed run — reading is an
 * iteration, not a submission.
 */
export async function readTrace(
  params: unknown,
  bundle: TraceBundle,
  options: TraceRenderOptions,
  signal?: AbortSignal,
): Promise<TraceRead> {
  const request = isRecord(params) ? params : {};
  const wanted = typeof request.trace === "string" ? request.trace.trim() : "";
  const trace = bundle.traces.find(candidate => candidate.id === wanted);
  if (!trace) {
    const known = bundle.traces.map(candidate => `${candidate.id} (${candidate.label})`).join(", ");
    return { text: `No trace "${wanted}" in this payload. The traces are: ${known}.`, readToEnd: null };
  }

  if (typeof request.jq === "string" && request.jq.trim() !== "") {
    const result = await runJq(request.jq, trace.records, signal === undefined ? {} : { signal });
    return {
      text: result.ok
        ? `jq ${request.jq.trim()} over trace ${trace.id} (${trace.records.length} records)\n${result.output}`
        : `jq could not answer that: ${result.error}`,
      readToEnd: null,
    };
  }

  const section = renderTraceSection(trace, options, {
    ...(typeof request.from === "number" ? { from: request.from } : {}),
    ...(typeof request.to === "number" ? { to: request.to } : {}),
    ...(typeof request.pattern === "string" ? { pattern: request.pattern } : {}),
    ...(typeof request.limit === "number" ? { limit: request.limit } : {}),
  });
  return { text: section.text, readToEnd: section.last === section.total ? trace.id : null };
}

/**
 * One evaluation: build the session, assert its surface, send the payload, and read the
 * answer out of the last `propose_lessons` call. No retry and no tool-call cap (the
 * deadline is the only bound); a run that never calls the tool is a failure, not an empty
 * result, and a run that stops without `tasks_completed` is unfinished however it answered
 * (ADR-0017).
 */
export async function runEvaluation(input: RunEvaluationInput): Promise<EvaluationRun> {
  // A scan that was cancelled before this run starts must not pay for it: the abort listener
  // below cannot fire for a signal that is already aborted.
  if (input.signal?.aborted) {
    return {
      status: "failed",
      reason: "cancelled",
      verdict: "",
      proposals: [],
      reads: [],
      traceSessionIds: input.bundle.traces.map(trace => trace.sessionId),
    };
  }
  assertHostVersion(input.sdk.VERSION);
  const now = input.now ?? Date.now();
  const deadline = now + input.config.timeout_seconds * 1_000;
  const submissions: Array<{ verdict: string; proposals: ProposalInput[] }> = [];
  const renderOptions = { includeThinking: input.config.include_thinking };
  /** Traces whose last record a `get_trace` section actually rendered (ADR-0017). */
  const tailsRead = new Set<string>();
  /** Whether the run exited through `tasks_completed` — the only clean exit there is. */
  let completed = false;

  const tool: ProposeLessonsTool = {
    name: PROPOSE_LESSONS_TOOL,
    label: "Propose lessons",
    description: PROPOSE_LESSONS_DESCRIPTION,
    parameters: PROPOSE_LESSONS_PARAMETERS,
    async execute(_toolCallId, params) {
      const answer = parseAnswer(params);
      if (!answer.ok) throw new Error(`Your answer was rejected: ${answer.error}. Call the tool again with a corrected answer.`);

      const resolved: ProposalInput[] = [];
      const errors: string[] = [];
      for (const lesson of answer.answer.lessons) {
        const citations = resolveCitations(lesson, input.bundle, renderOptions);
        if (!citations.ok) {
          errors.push(...citations.errors.map(reason => `${lesson.title}: ${reason}`));
          continue;
        }
        resolved.push({ lesson, resolved: citations.resolved });
      }
      if (errors.length > 0) {
        throw new Error(
          `These citations do not resolve against the traces you were given, so the lesson was not recorded: ${errors.join("; ")}. Fix the ids and call the tool again (or drop the lesson).`,
        );
      }

      submissions.push({
        verdict: answer.answer.verdict,
        proposals: answer.answer.lessons.map((lesson, index) => ({ lesson, resolved: resolved[index]?.resolved ?? [] })),
      });
      return {
        content: [
          {
            type: "text",
            text: `Recorded. Read every trace to its end, then call ${TASKS_COMPLETED_TOOL} — that call is what ends the run.`,
          },
        ],
      };
    },
  };

  const traceTool: EvaluatorTool = {
    name: GET_TRACE_TOOL,
    label: "Read a trace section",
    description: GET_TRACE_DESCRIPTION,
    parameters: GET_TRACE_PARAMETERS,
    async execute(_toolCallId, params) {
      const read = await readTrace(params, input.bundle, renderOptions, input.signal);
      if (read.readToEnd !== null) tailsRead.add(read.readToEnd);
      return { content: [{ type: "text", text: read.text }] };
    },
  };

  const completionTool: EvaluatorTool = {
    name: TASKS_COMPLETED_TOOL,
    label: "Finish the run",
    description: TASKS_COMPLETED_DESCRIPTION,
    parameters: TASKS_COMPLETED_PARAMETERS,
    async execute() {
      const unread = input.bundle.traces.filter(trace => trace.records.length > 0 && !tailsRead.has(trace.id));
      if (unread.length > 0) {
        throw new Error(
          `Make sure you went through ALL the session looking for lessons and patterns before calling this tool. Not read to the end: ${unread
            .map(trace => `${trace.id} (${trace.records.length} record${trace.records.length === 1 ? "" : "s"})`)
            .join(", ")}.`,
        );
      }
      completed = true;
      return { content: [{ type: "text", text: "The run is finished. This was your final action." }] };
    },
  };

  // The evaluator inherits the operator's settings and deliberately not the project's. A
  // project `.omp/settings.json` is instruction-shaped configuration for coding sessions —
  // `advisor.enabled` attaches a second model that reviews every turn (with the project's
  // `WATCHDOG.md`/`WATCHDOG.yml` fed to it), `workspace.additionalDirectories` widens what the
  // read tools can open, `tools.approval.*` can gate them outright — and none of it should steer
  // a session whose only input is a trace. See `evaluatorSettings` for what that costs a host.
  const settings = await evaluatorSettings(input.sdk, input.agentDir);

  const session = (
    await input.sdk.createAgentSession(
      sealedSessionOptions({
        projectRoot: input.paths.projectRoot,
        evaluatorPrompt: input.evaluatorPrompt,
        tools: [traceTool, tool, completionTool],
        sessionManager: input.sdk.SessionManager.inMemory(input.paths.projectRoot),
        modelRegistry: input.modelRegistry,
        settings,
        model: input.model,
        thinkingLevel: thinkingLevelFromConfig(input.config.thinking),
        timeoutSeconds: input.config.timeout_seconds,
        now,
      }),
    )
  ).session;

  const abortRun = () => session.abort?.();
  input.signal?.addEventListener("abort", abortRun, { once: true });

  try {
    assertToolSurface(session.getEnabledToolNames());

    let failure: string | undefined;
    try {
      await session.prompt(input.payload);
      await session.waitForIdle();
    } catch (error) {
      failure = describeRunFailure(error, input.config.timeout_seconds);
    }
    if (input.signal?.aborted && failure === undefined) failure = "cancelled";
    // A failed model call does not throw: the run settles with an error stop reason, which is
    // where the provider's own words live ("maximum context length", a 400, an auth refusal).
    if (failure === undefined && submissions.length === 0) {
      const settled = session.getLastAssistantMessage?.();
      const settledReason = typeof settled?.stopReason === "string" ? settled.stopReason : undefined;
      if (settledReason === "error") {
        const detail = typeof settled?.errorMessage === "string" ? settled.errorMessage.split("\n")[0]?.trim() : "";
        failure = `the evaluator's model call failed${detail ? `: ${capText(detail, 300)}` : ""}`;
      } else if (settledReason === "aborted") {
        failure = "the evaluator's run was aborted";
      }
    }
    // The host ends a deadline-exceeded stream gracefully rather than throwing, so the
    // deadline is re-checked here: otherwise a timed-out run would be recorded as one that
    // simply never called the tool, which is the wrong reason under D14.
    if (failure === undefined && !completed && Date.now() >= deadline) {
      failure = `exceeded the ${input.config.timeout_seconds}s deadline`;
    }
    // The exit is a call, not a silence: a run that stopped without it is unfinished, however
    // good its answer was, and its traces stay eligible (ADR-0017). A run that never answered
    // at all keeps the older, more specific reason below.
    if (failure === undefined && !completed && submissions.length > 0) {
      failure = `the evaluator finished without calling ${TASKS_COMPLETED_TOOL}`;
    }

    const reads = readPathsFromTranscript(session.sessionManager.getEntries());
    const last = submissions[submissions.length - 1];

    if (failure !== undefined) {
      return { status: "failed", reason: failure, verdict: "", proposals: [], reads, traceSessionIds: traceIds(input.bundle) };
    }

    if (!last) {
      return {
        status: "failed",
        reason: "the evaluator finished without calling propose_lessons",
        verdict: "",
        proposals: [],
        reads,
        traceSessionIds: traceIds(input.bundle),
      };
    }
    return {
      status: last.proposals.length === 0 ? "empty" : "lessons",
      verdict: last.verdict,
      proposals: last.proposals,
      reads,
      traceSessionIds: traceIds(input.bundle),
    };
  } finally {
    input.signal?.removeEventListener("abort", abortRun);
    await session.dispose();
  }
}

/** Configured selectors are validated at setup; an unrecognized one is simply not passed. */
function thinkingLevelFromConfig(thinking: string | undefined): ConfiguredThinkingLevel | undefined {
  if (!thinking) return undefined;
  const known: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];
  return known.includes(thinking) ? (thinking as ConfiguredThinkingLevel) : undefined;
}

function describeRunFailure(error: unknown, timeoutSeconds: number): string {
  const name = isRecord(error) && typeof error.name === "string" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return `exceeded the ${timeoutSeconds}s deadline`;
  return messageOf(error);
}

function traceIds(bundle: TraceBundle): string[] {
  return bundle.traces.map(trace => trace.sessionId);
}

/**
 * The evaluator's own transcript is the only place its reads survive — the built-in tools
 * leave no other trail (ADR-0009) — so the ledger's read log is reconstructed from it.
 */
export function readPathsFromTranscript(entries: readonly unknown[]): string[] {
  const reads = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
      if (!["read", "glob", "grep", GET_TRACE_TOOL].includes(part.name)) continue;
      const args = isRecord(part.arguments) ? part.arguments : {};
      if (part.name === GET_TRACE_TOOL) {
        const trace = typeof args.trace === "string" ? args.trace : "?";
        const how =
          typeof args.jq === "string"
            ? `jq ${args.jq}`
            : typeof args.pattern === "string"
              ? `pattern "${args.pattern}"`
              : `records ${typeof args.from === "number" ? args.from : 1}${typeof args.to === "number" ? `..${args.to}` : ".."}`;
        reads.add(`get_trace ${trace} ${how}`);
        continue;
      }
      const where = typeof args.path === "string" ? args.path : undefined;
      if (part.name === "grep" && typeof args.pattern === "string") {
        reads.add(`grep ${args.pattern} in ${where ?? "."}`);
      } else if (where) {
        reads.add(`${part.name} ${where}`);
      }
    }
  }
  return [...reads].sort();
}
