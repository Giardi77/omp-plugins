import { summarizeToolCall, type ToolExecutionLike } from "./stream.ts";

/**
 * The plugin-owned approval gate. Runs inside the awaited `tool_call` extension hook,
 * BEFORE the built-in approval gate — so pair it with `tools.approvalMode: yolo`
 * or every call double-prompts.
 *
 * Decision flow: read-only tools and session-remembered "always allow" tools pass;
 * everything else races the available surfaces (Telegram card, TUI dialog) — first
 * answer wins, late answers are ignored. Timeout denies (fail-closed). If every
 * surface errors, the call passes through to OMP's built-in gate (fail-open),
 * which is exactly why yolo must not be set without a healthy bridge.
 */

export type ApprovalDecision = "approve" | "deny" | "always";

export interface ApprovalRequest {
  toolName: string;
  summary: string;
}

export type ApprovalSurface = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export interface ApprovalVerdict {
  block?: boolean;
  reason?: string;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);

const DEFAULT_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class ApprovalGate {
  #alwaysAllowed = new Set<string>();

  constructor(
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly sleepFn: (ms: number) => Promise<void> = sleep,
  ) {}

  isExempt(toolName: string): boolean {
    return READ_ONLY_TOOLS.has(toolName) || this.#alwaysAllowed.has(toolName);
  }

  /** Undefined verdict = let the call through (to execution or the built-in gate). */
  async decide(
    event: Pick<ToolExecutionLike, "toolName" | "args">,
    surfaces: ReadonlyArray<ApprovalSurface | undefined>,
  ): Promise<ApprovalVerdict | undefined> {
    if (this.isExempt(event.toolName)) return undefined;

    const active = surfaces.filter((surface): surface is ApprovalSurface => surface !== undefined);
    if (active.length === 0) return undefined;

    const summary = summarizeToolCall(event.toolName, event.args);
    const decision = await this.#race(active, { toolName: event.toolName, summary });

    if (decision === "approve") return undefined;
    if (decision === "always") {
      this.#alwaysAllowed.add(event.toolName);
      return undefined;
    }
    if (decision === "deny") return { block: true, reason: `Denied: ${summary}` };
    if (decision === "timeout") return { block: true, reason: `Approval timed out: ${summary}` };
    return undefined; // every surface errored — defer to the built-in gate
  }

  /**
   * First successful answer wins; an erroring surface falls through to the next finisher.
   * Each surface is invoked exactly once (a second card/dialog per decision is a bug).
   */
  async #race(surfaces: readonly ApprovalSurface[], request: ApprovalRequest): Promise<ApprovalDecision | "timeout" | "error"> {
    const timeout = this.sleepFn(this.timeoutMs).then((): "timeout" => "timeout");
    const attempts = surfaces.map((surface, index) =>
      surface(request).then(
        (value: ApprovalDecision) => ({ index, ok: true as const, value }),
        () => ({ index, ok: false as const }),
      ),
    );
    const remaining = new Set(attempts);
    while (remaining.size > 0) {
      const result = await Promise.race([...remaining, timeout]);
      if (result === "timeout") return "timeout";
      remaining.delete(attempts[result.index]);
      if (result.ok) return result.value;
    }
    return "error";
  }
}
