import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isRecord } from "./util";

/**
 * A trace is the bounded, derived view of one session — or of one of its subagents —
 * that the evaluator reads. It is never persisted raw (ADR-0006): records are rendered
 * to text on demand, capped, and thrown away with the run.
 *
 * Included: user prompts, assistant text, tool calls with capped arguments, tool results
 * with their error flag and capped output, usage, model/thinking/service-tier changes,
 * title changes, and injected `custom_message` records such as the advisor's.
 * Excluded: developer scaffolding, reasoning (unless `includeThinking`), session-state
 * `custom` records, compaction and branch summaries, and provider payloads.
 */

export const MAX_TEXT_CHARS = 4_000;
export const MAX_ARGUMENT_CHARS = 2_000;
export const MAX_OUTPUT_CHARS = 4_000;
export const MAX_THINKING_CHARS = 2_000;
export const MAX_EXCERPT_CHARS = 1_200;

export interface Trace {
  /** Short, stable id used in citations: `<traceId>:<recordId>`. */
  id: string;
  sessionId: string;
  sessionFile: string;
  role: "parent" | "subagent";
  /** Human-readable trace label, printed in the payload. */
  label: string;
  records: SessionEntry[];
}

export interface TraceBundle {
  projectRoot: string;
  sessionId: string;
  sessionFile: string;
  traces: Trace[];
}

export interface TraceRenderOptions {
  includeThinking: boolean;
}

interface ContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface UsageView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

/** The subset of a persisted message the trace reads, parsed at the boundary. */
interface MessageView {
  role: string;
  parts: ContentPart[];
  toolName?: string;
  isError: boolean;
  usage?: UsageView;
}

export function buildBundle(input: {
  projectRoot: string;
  sessionId: string;
  sessionFile: string;
  parent: SessionEntry[];
  subagents: Array<{ label: string; sessionId: string; sessionFile: string; entries: SessionEntry[] }>;
}): TraceBundle {
  const used = new Set<string>();
  const uniqueId = (sessionId: string): string => {
    const compact = sessionId.replace(/[^0-9a-zA-Z]/g, "").toLowerCase();
    for (const width of [8, 12, 16, 32]) {
      const candidate = compact.slice(0, width);
      if (candidate !== "" && !used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    const base = compact.slice(0, 8) || "trace";
    let counter = 1;
    while (used.has(`${base}-${counter}`)) counter++;
    used.add(`${base}-${counter}`);
    return `${base}-${counter}`;
  };

  return {
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    traces: [
      {
        id: uniqueId(input.sessionId),
        sessionId: input.sessionId,
        sessionFile: input.sessionFile,
        role: "parent",
        label: "parent session",
        records: input.parent,
      },
      ...input.subagents.map(subagent => ({
        id: uniqueId(subagent.sessionId),
        sessionId: subagent.sessionId,
        sessionFile: subagent.sessionFile,
        role: "subagent" as const,
        label: `subagent ${subagent.label}`,
        records: subagent.entries,
      })),
    ],
  };
}

/**
 * The payload: the session's traces and nothing else (D17). The evaluator finds the
 * project's own skills and prompts with its tools; the trace carries only what happened.
 */
export function renderPayload(bundle: TraceBundle, options: TraceRenderOptions): string {
  const lines: string[] = [];
  lines.push("# distill payload");
  lines.push("");
  lines.push(`project: ${bundle.projectRoot}`);
  lines.push(`session: ${bundle.sessionId}`);
  lines.push(`traces: ${bundle.traces.length}`);
  lines.push("");

  for (const trace of bundle.traces) {
    lines.push(`## trace ${trace.id} — ${trace.label}`);
    lines.push(`session ${trace.sessionId}, ${trace.records.length} records`);
    lines.push("");
    for (const record of trace.records) {
      for (const line of renderRecord(record, options)) lines.push(`[${record.id}] ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** The record's own text, as the evaluator sees it: no record id, capped per part. */
export function renderRecord(entry: SessionEntry, options: TraceRenderOptions): string[] {
  switch (entry.type) {
    case "message": {
      const message = readMessage(entry.message);
      return message ? renderMessage(message, options) : [];
    }
    case "custom_message": {
      const attribution = typeof entry.attribution === "string" ? ` (${entry.attribution})` : "";
      return [`injected ${entry.customType}${attribution}: ${capText(contentText(entry.content), MAX_TEXT_CHARS)}`];
    }
    case "model_change":
      return [`model: ${entry.model}`];
    case "thinking_level_change":
      return [`thinkingLevel: ${entry.thinkingLevel ?? entry.configured ?? "default"}`];
    case "service_tier_change":
      return [`serviceTier: ${JSON.stringify(entry.serviceTier ?? null)}`];
    case "title_change":
      return [`title: ${entry.title}`];
    default:
      return [];
  }
}

/** Verbatim evidence for one cited record; the plugin extracts it, never the model (D12). */
export function excerptFor(entry: SessionEntry, options: TraceRenderOptions = { includeThinking: true }): string {
  return capText(renderRecord(entry, options).join("\n"), MAX_EXCERPT_CHARS);
}

function renderMessage(message: MessageView, options: TraceRenderOptions): string[] {
  if (message.role === "toolResult") {
    const flag = message.isError ? " error" : "";
    return [`toolResult ${message.toolName ?? "tool"}${flag}: ${capText(contentText(message.parts), MAX_OUTPUT_CHARS)}`];
  }

  if (message.role === "user") {
    return [`user: ${capText(contentText(message.parts), MAX_TEXT_CHARS)}`];
  }

  if (message.role !== "assistant") return [];

  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
      lines.push(`assistant: ${capText(part.text, MAX_TEXT_CHARS)}`);
    } else if (part.type === "thinking" && options.includeThinking && typeof part.thinking === "string") {
      lines.push(`thinking: ${capText(part.thinking, MAX_THINKING_CHARS)}`);
    } else if (part.type === "toolCall") {
      lines.push(`assistant toolCall ${part.name ?? "tool"}: ${capText(safeJson(part.arguments), MAX_ARGUMENT_CHARS)}`);
    }
  }

  const usage = usageLine(message.usage);
  if (usage) lines.push(usage);
  return lines;
}

function readMessage(value: unknown): MessageView | undefined {
  if (!isRecord(value) || typeof value.role !== "string") return undefined;
  return {
    role: value.role,
    parts: readParts(value.content),
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    isError: value.isError === true,
    usage: readUsage(value.usage),
  };
}

function readParts(content: unknown): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    parts.push({
      type: part.type,
      text: typeof part.text === "string" ? part.text : undefined,
      thinking: typeof part.thinking === "string" ? part.thinking : undefined,
      id: typeof part.id === "string" ? part.id : undefined,
      name: typeof part.name === "string" ? part.name : undefined,
      arguments: part.arguments,
    });
  }
  return parts;
}

function readUsage(value: unknown): UsageView | undefined {
  if (!isRecord(value)) return undefined;
  const number = (input: unknown) => (typeof input === "number" ? input : 0);
  return {
    input: number(value.input),
    output: number(value.output),
    cacheRead: number(value.cacheRead),
    cacheWrite: number(value.cacheWrite),
    totalTokens: number(value.totalTokens),
    cost: isRecord(value.cost) ? number(value.cost.total) : 0,
  };
}

function usageLine(usage: UsageView | undefined): string | undefined {
  if (!usage) return undefined;
  const { input, output, cacheRead, cacheWrite, totalTokens, cost } = usage;
  if (input + output + cacheRead + cacheWrite + totalTokens + cost === 0) return undefined;
  return `usage: input ${input}, output ${output}, cacheRead ${cacheRead}, cacheWrite ${cacheWrite}, total ${totalTokens}, cost $${cost.toFixed(4)}`;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part.type === "thinking" && typeof part.thinking === "string") texts.push(part.thinking);
  }
  return texts.join("\n");
}

export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated, ${text.length - limit} characters omitted]`;
}

function safeJson(value: unknown): string {
  if (value === undefined) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
