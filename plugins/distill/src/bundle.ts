import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadSession, resolveBranch, subagentSessionFiles } from "./store";
import { buildBundle, renderInventory, type TraceBundle, type TraceRenderOptions } from "./trace";

/**
 * Assembles the payload source for one session: the parent trace plus every subagent
 * trace, in one bundle (D13). Traces are derived here and never persisted.
 */

export interface EvaluationPlan {
  /** One bundle per evaluator run: the whole session when it fits, else one trace each. */
  groups: TraceBundle[];
  /**
   * Traces that fit nowhere: they fail loudly and stay eligible rather than being truncated.
   * Both ids are carried — `traceId` is what a payload prints, `sessionId` is what the ledger
   * and retirement speak.
   */
  oversized: Array<{ traceId: string; sessionId: string; chars: number }>;
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
  if (renderInventory(bundle, options).length <= budgetChars) return { groups: [bundle], oversized: [] };

  // The payload is additive — one header, then each trace's records — so a greedy pack over the
  // traces needs each trace's own size and the header's, and nothing else. Packing matters: a
  // bundle 12% over the budget should cost two runs, not one per trace.
  const headerChars = renderInventory({ ...bundle, traces: [] }, options).length;
  const oversized: Array<{ traceId: string; sessionId: string; chars: number }> = [];
  const groups: TraceBundle[] = [];
  let current: TraceBundle["traces"] = [];
  let used = headerChars;

  for (const trace of bundle.traces) {
    const chars = renderInventory({ ...bundle, traces: [trace] }, options).length;
    const body = chars - headerChars;
    if (chars > budgetChars) {
      oversized.push({ traceId: trace.id, sessionId: trace.sessionId, chars });
      continue;
    }
    if (used + body > budgetChars && current.length > 0) {
      groups.push({ ...bundle, traces: current });
      current = [];
      used = headerChars;
    }
    current.push(trace);
    used += body;
  }
  if (current.length > 0) groups.push({ ...bundle, traces: current });
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
