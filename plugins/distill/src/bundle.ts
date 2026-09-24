import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadSession, resolveBranch, subagentSessionFiles } from "./store";
import { buildBundle, renderPayload, type TraceBundle, type TraceRenderOptions } from "./trace";

/**
 * Assembles the payload source for one session: the parent trace plus every subagent
 * trace, in one bundle (D13). Traces are derived here and never persisted.
 */

export interface EvaluationPlan {
  /** One bundle per evaluator run: the whole session when it fits, else one trace each. */
  groups: TraceBundle[];
  /** Traces that fit nowhere: they fail loudly and stay eligible rather than being truncated. */
  oversized: Array<{ traceId: string; chars: number }>;
}

/**
 * Decides what one scan sends. A session's whole bundle goes in one payload while it fits the
 * model; past that, the payload is split by trace — the upgrade path the spec records for a
 * session too large for the model — and a single trace that still does not fit is named so it
 * can fail loudly instead of being silently truncated (ADR-0005, ADR-0008).
 */
export function planEvaluations(
  bundle: TraceBundle,
  budgetChars: number,
  options: TraceRenderOptions,
): EvaluationPlan {
  if (renderPayload(bundle, options).length <= budgetChars) return { groups: [bundle], oversized: [] };

  const groups: TraceBundle[] = [];
  const oversized: Array<{ traceId: string; chars: number }> = [];
  for (const trace of bundle.traces) {
    const single: TraceBundle = { ...bundle, traces: [trace] };
    const chars = renderPayload(single, options).length;
    if (chars <= budgetChars) groups.push(single);
    else oversized.push({ traceId: trace.id, chars });
  }
  return { groups, oversized };
}

export interface BundleRequest {
  sessionFile: string;
  projectRoot: string;
}

export type BundleResult =
  | { ok: true; bundle: TraceBundle; warnings: string[] }
  | { ok: false; reason: string };

interface SubagentTrace {
  label: string;
  sessionId: string;
  sessionFile: string;
  entries: SessionEntry[];
}

export async function loadTraceBundle(request: BundleRequest): Promise<BundleResult> {
  const parent = await loadSession(request.sessionFile);
  if (!parent.ok) return { ok: false, reason: parent.reason };

  const subagents: SubagentTrace[] = [];
  const warnings: string[] = [];

  for (const file of await subagentSessionFiles(request.sessionFile)) {
    const loaded = await loadSession(file);
    if (!loaded.ok) {
      warnings.push(`${path.basename(file)}: ${loaded.reason}`);
      continue;
    }
    subagents.push({
      label: path.basename(file, ".jsonl"),
      sessionId: loaded.session.header.id,
      sessionFile: file,
      entries: resolveBranch(loaded.session.entries),
    });
  }

  return {
    ok: true,
    warnings,
    bundle: buildBundle({
      projectRoot: request.projectRoot,
      sessionId: parent.session.header.id,
      sessionFile: request.sessionFile,
      parent: resolveBranch(parent.session.entries),
      subagents,
    }),
  };
}
