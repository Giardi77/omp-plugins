import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { DistillPaths } from "./config";
import type { DistillConfig } from "./config";
import {
  parseAnswer,
  PROPOSE_LESSONS_DESCRIPTION,
  PROPOSE_LESSONS_PARAMETERS,
  PROPOSE_LESSONS_TOOL,
  resolveCitations,
} from "./contract";
import type { ProposalInput } from "./lessons";
import { isRecord, messageOf } from "./util";
import { capText, type TraceBundle } from "./trace";

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

export const EVALUATOR_TOOL_NAMES: readonly string[] = ["read", "glob", "grep", PROPOSE_LESSONS_TOOL];

/** Conservative characters per token: a measured trace ran ~3.3, and underestimating splits early. */
export const CHARS_PER_TOKEN = 3;
/** Head-room for the system prompt, the tool description and tokenizer drift. */
export const PROMPT_SAFETY_TOKENS = 8_000;
/** Used when the host cannot say what the model's window is. */
export const DEFAULT_PAYLOAD_BUDGET_CHARS = 400_000;

/**
 * How much payload one evaluation may carry: the model's window minus the completion it
 * reserves, since a thinking model that reserves half the window cannot take a full one.
 */
export function payloadBudgetChars(
  model: { contextWindow?: number | null; maxTokens?: number | null } | undefined,
): number {
  const window = model?.contextWindow ?? 0;
  if (!Number.isFinite(window) || window <= 0) return DEFAULT_PAYLOAD_BUDGET_CHARS;
  const declared = model?.maxTokens ?? 0;
  const reserve = Math.min(declared > 0 ? declared : Math.floor(window / 4), Math.floor(window / 2));
  return Math.max(20_000, (window - reserve - PROMPT_SAFETY_TOKENS) * CHARS_PER_TOKEN);
}

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

/** The injected SDK surface; `pi.pi` satisfies it. */
export interface EvaluatorSdkLike {
  VERSION: string;
  createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: EvaluatorSessionLike }>;
  SessionManager: { inMemory(cwd?: string): EvaluatorSessionManager };
}

export interface ProposeLessonsTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export interface SealedSessionInput {
  projectRoot: string;
  evaluatorPrompt: string;
  tool: ProposeLessonsTool;
  sessionManager: EvaluatorSessionManager;
  modelRegistry: EvaluatorModelRegistry;
  model?: EvaluatorModel;
  thinkingLevel?: ConfiguredThinkingLevel;
  timeoutSeconds: number;
  now: number;
}

/**
 * The sealed option set (ADR-0007, ADR-0009). Every entry is load-bearing: drop
 * `parentTaskPrefix` and the evaluator claims process globals as the main session; drop
 * `SessionManager.inMemory()` and it writes its own transcript into the store it reads.
 */
export function sealedSessionOptions(input: SealedSessionInput): CreateAgentSessionOptions {
  return {
    cwd: input.projectRoot,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    systemPrompt: [input.evaluatorPrompt],
    toolNames: [...EVALUATOR_TOOL_NAMES],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    customTools: [input.tool],
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

/**
 * One evaluation: build the session, assert its surface, send the payload, and read the
 * answer out of the last `propose_lessons` call. No retry and no tool-call cap (the
 * deadline is the only bound); a run that never calls the tool is a failure, not an empty
 * result.
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
      return { content: [{ type: "text", text: "Recorded. This was your final action." }] };
    },
  };

  const session = (
    await input.sdk.createAgentSession(
      sealedSessionOptions({
        projectRoot: input.paths.projectRoot,
        evaluatorPrompt: input.evaluatorPrompt,
        tool,
        sessionManager: input.sdk.SessionManager.inMemory(input.paths.projectRoot),
        modelRegistry: input.modelRegistry,
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
    if (failure === undefined && submissions.length === 0 && Date.now() >= deadline) {
      failure = `exceeded the ${input.config.timeout_seconds}s deadline`;
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
      if (!["read", "glob", "grep"].includes(part.name)) continue;
      const args = isRecord(part.arguments) ? part.arguments : {};
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
