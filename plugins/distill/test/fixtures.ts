import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

/**
 * Synthetic session files in the shape omp writes (version 3): a fixed-width title
 * slot, the `type:"session"` header, then records carrying `id` + `parentId`.
 * A real transcript must never be committed, so every test builds its own.
 */

export interface RecordContext {
  id: string;
  parentId: string | null;
  timestamp?: string;
}

export function titleSlot(title = ""): string {
  return JSON.stringify({
    type: "title",
    v: 1,
    title,
    updatedAt: "2026-09-23T15:13:43.576Z",
    pad: " ".repeat(200),
  });
}

export function sessionHeader(options: {
  id: string;
  cwd: string;
  version?: number;
  title?: string;
  parentSession?: string;
}): string {
  return JSON.stringify({
    type: "session",
    version: options.version ?? 3,
    id: options.id,
    timestamp: "2026-09-23T15:13:43.576Z",
    cwd: options.cwd,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
  });
}

function entry(context: RecordContext, body: Record<string, unknown>): string {
  return JSON.stringify({
    id: context.id,
    parentId: context.parentId,
    timestamp: context.timestamp ?? "2026-09-23T15:14:00.000Z",
    ...body,
  });
}

export function userMessage(context: RecordContext, text: string): string {
  return entry(context, { type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

export function assistantMessage(
  context: RecordContext,
  parts: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): string {
  return entry(context, { type: "message", message: { role: "assistant", content: parts, ...extra } });
}

export function textPart(text: string): Record<string, unknown> {
  return { type: "text", text };
}

export function thinkingPart(thinking: string): Record<string, unknown> {
  return { type: "thinking", thinking, thinkingSignature: "reasoning_content" };
}

export function toolCallPart(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "toolCall", id, name, arguments: args, streamIndex: 0 };
}

export function toolResultMessage(
  context: RecordContext,
  options: { toolCallId: string; toolName: string; text: string; isError?: boolean },
): string {
  return entry(context, {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      content: [{ type: "text", text: options.text }],
      ...(options.isError === undefined ? {} : { isError: options.isError }),
    },
  });
}

export function developerMessage(context: RecordContext, text: string): string {
  return entry(context, { type: "message", message: { role: "developer", content: [{ type: "text", text }] } });
}

export function advisorMessage(context: RecordContext, content: string): string {
  return customMessage(context, { customType: "advisor", content, attribution: "agent" });
}

export function customMessage(
  context: RecordContext,
  options: { customType: string; content: string; attribution?: string },
): string {
  return entry(context, {
    type: "custom_message",
    customType: options.customType,
    content: options.content,
    display: true,
    ...(options.attribution === undefined ? {} : { attribution: options.attribution }),
  });
}

export function customEntry(context: RecordContext, customType: string, data: unknown = {}): string {
  return entry(context, { type: "custom", customType, data });
}

export function modelChange(context: RecordContext, model: string): string {
  return entry(context, { type: "model_change", model });
}

export function thinkingLevelChange(context: RecordContext, level: string): string {
  return entry(context, { type: "thinking_level_change", thinkingLevel: level, configured: level });
}

export function serviceTierChange(context: RecordContext, serviceTier: Record<string, string>): string {
  return entry(context, { type: "service_tier_change", serviceTier });
}

export function titleChange(context: RecordContext, title: string): string {
  return entry(context, { type: "title_change", title, source: "auto" });
}

export function compaction(context: RecordContext, summary: string): string {
  return entry(context, { type: "compaction", summary, firstKeptEntryId: context.id, tokensBefore: 1000 });
}

export interface SessionFixtureOptions {
  /** Directory the session file is written into. */
  dir: string;
  sessionId: string;
  cwd: string;
  /** Record lines, in file order, after the header. */
  lines: string[];
  /** File-name timestamp; also decides ordering when two fixtures share a directory. */
  fileTimestamp?: string;
  version?: number;
  titleSlotTitle?: string;
  /** Subagent transcripts written into the session's sibling directory. */
  subagents?: Array<{ name: string; sessionId: string; lines: string[] }>;
}

/** Writes one session file (and any subagent files) and returns the session path. */
export async function writeSessionFixture(options: SessionFixtureOptions): Promise<string> {
  await fs.mkdir(options.dir, { recursive: true });
  const stamp = (options.fileTimestamp ?? "2026-09-23T15-13-43-576Z").replace(/[:.]/g, "-");
  const sessionPath = path.join(options.dir, `${stamp}_${options.sessionId}.jsonl`);
  const body = [
    titleSlot(options.titleSlotTitle ?? ""),
    sessionHeader({ id: options.sessionId, cwd: options.cwd, version: options.version }),
    ...options.lines,
  ];
  await fs.writeFile(sessionPath, `${body.join("\n")}\n`);

  for (const subagent of options.subagents ?? []) {
    const subagentDir = sessionPath.slice(0, -".jsonl".length);
    const subagentPath = path.join(subagentDir, `${subagent.name}.jsonl`);
    await fs.mkdir(path.dirname(subagentPath), { recursive: true });
    await fs.writeFile(
      subagentPath,
      `${[
        titleSlot(),
        sessionHeader({ id: subagent.sessionId, cwd: options.cwd }),
        ...subagent.lines,
      ].join("\n")}\n`,
    );
  }

  return sessionPath;
}

/** Fixture lines are trusted test data; parse them once here rather than casting at use sites. */
export function entriesOf(lines: string[]): SessionEntry[] {
  return lines.map(line => JSON.parse(line) as SessionEntry);
}

export async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
