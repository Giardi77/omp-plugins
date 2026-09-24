import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadSession, resolveBranch, subagentSessionFiles } from "./store";
import { buildBundle, type TraceBundle } from "./trace";

/**
 * Assembles the payload source for one session: the parent trace plus every subagent
 * trace, in one bundle (D13). Traces are derived here and never persisted.
 */

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
