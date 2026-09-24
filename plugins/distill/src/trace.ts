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
export const MAX_THINKING_CHARS = 2_000;
export const MAX_EXCERPT_CHARS = 1_200;
export const MAX_INJECTED_CHARS = 1_500;
/**
 * Tool output is summarised in the payload, not quoted: results are over half a real session's
 * bytes, and the evaluator has `read`/`grep` and each trace's transcript path, so it can open
 * the record when the detail matters. Errors keep more of their first line than successes,
 * because a refusal or a failure is the signal a lesson is built on.
 */
export const MAX_RESULT_LINE_CHARS = 240;
export const MAX_ERROR_LINE_CHARS = 600;

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
 * The payload: an inventory of the session's traces — each one's id, label, record range, size
 * and transcript file — and no records (ADR-0013). Records are read with `get_trace`, a bounded
 * section at a time, so a scan never hands the evaluator more than it asked to see.
 */
export function renderInventory(bundle: TraceBundle, options: TraceRenderOptions): string {
  const lines: string[] = [];
  lines.push("# distill payload");
  lines.push("");
  lines.push(`project: ${bundle.projectRoot}`);
  lines.push(`session: ${bundle.sessionId}`);
  lines.push(`traces: ${bundle.traces.length}`);
  lines.push("");

  for (const trace of bundle.traces) {
    lines.push(...renderTraceHeader(trace));
    lines.push(`chars ${traceChars(trace, options)}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** One trace's block: who it is, how many records it holds, and where they live. */
function renderTraceHeader(trace: Trace): string[] {
  return [
    `## trace ${trace.id} — ${trace.label}`,
    `session ${trace.sessionId}`,
    `file ${trace.sessionFile}`,
    `records 1..${trace.records.length}`,
  ];
}

/** Characters this trace's records render to. CPU only: the number never enters a context. */
export function traceChars(trace: Trace, options: TraceRenderOptions): number {
  return trace.records.reduce((total, record) => total + renderRecord(record, options).join("\n").length, 0);
}

export const DEFAULT_SECTION_RECORDS = 60;
export const MAX_SECTION_RECORDS = 200;
/** A section stops here even with records to spare: more is one call away. */
export const MAX_SECTION_CHARS = 40_000;

export interface SectionRequest {
  /** 1-based ordinal of the first record to return. */
  from?: number;
  /** Inclusive last ordinal; default is the far end of the trace. */
  to?: number;
  /** Case-insensitive substring; when given, only matching records are returned. */
  pattern?: string;
  limit?: number;
}

export interface TraceSection {
  text: string;
  /** 1-based ordinals of the records actually returned; 0 when nothing was. */
  first: number;
  last: number;
  /** How many records the trace holds, and how many matched the pattern. */
  total: number;
  matched: number;
  truncated: boolean;
}

/**
 * One section of one trace, rendered exactly as the payload used to render a whole trace: the
 * same exclusions, the same caps, the same record ids a citation needs.
 */
export function renderTraceSection(
  trace: Trace,
  options: TraceRenderOptions,
  request: SectionRequest = {},
): TraceSection {
  const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_SECTION_RECORDS, MAX_SECTION_RECORDS));
  const pattern = request.pattern?.trim().toLowerCase();
  const wanted = trace.records
    .map((record, index) => ({
      record,
      ordinal: index + 1,
      body: renderRecord(record, options).map(line => `[${record.id}] ${line}`),
    }))
    .filter(entry => pattern === undefined || entry.body.join("\n").toLowerCase().includes(pattern));

  const from = Math.max(1, request.from ?? 1);
  const selected = wanted.filter(
    entry => entry.ordinal >= from && (request.to === undefined || entry.ordinal <= request.to),
  );

  const lines: string[] = [...renderTraceHeader(trace)];
  if (pattern !== undefined) lines.push(`pattern "${request.pattern?.trim()}" — ${wanted.length} match(es)`);

  let chars = 0;
  let last = 0;
  let shown = 0;
  let truncated = false;
  for (const entry of selected) {
    const size = entry.body.join("\n").length + 1;
    if (shown >= limit || (shown > 0 && chars + size > MAX_SECTION_CHARS)) {
      truncated = true;
      break;
    }
    lines.push(...entry.body);
    chars += size;
    shown += 1;
    last = entry.ordinal;
  }

  lines.push("");
  if (shown === 0) {
    lines.push(pattern !== undefined && wanted.length === 0 ? "nothing matched" : "no records in that range");
    return {
      text: lines.join("\n"),
      first: 0,
      last: 0,
      total: trace.records.length,
      matched: wanted.length,
      truncated: false,
    };
  }

  const first = selected[0]?.ordinal ?? 0;
  lines.push(
    `section: records ${first}..${last} of ${trace.records.length}${pattern === undefined ? "" : ` (${wanted.length} matched)`}`,
  );
  // Look past what was asked for: "end of what you asked for" must not read as "end of trace".
  const next = wanted.find(entry => entry.ordinal > last);
  const continuation = `get_trace trace="${trace.id}"${pattern === undefined ? "" : ` pattern="${request.pattern?.trim()}"`} from=`;
  lines.push(
    next === undefined
      ? "end of what you asked for"
      : `${truncated ? "section limit reached; " : ""}next: ${continuation}${next.ordinal}`,
  );
  return { text: lines.join("\n"), first, last, total: trace.records.length, matched: wanted.length, truncated };
}

/** The record's own text, as the evaluator sees it: no record id, capped per part. */
export function renderRecord(entry: SessionEntry, options: TraceRenderOptions, elideResults = true): string[] {
  switch (entry.type) {
    case "message": {
      const message = readMessage(entry.message);
      return message ? renderMessage(message, options, elideResults) : [];
    }
    case "custom_message": {
      const attribution = typeof entry.attribution === "string" ? ` (${entry.attribution})` : "";
      return [`injected ${entry.customType}${attribution}: ${capText(contentText(entry.content), MAX_INJECTED_CHARS)}`];
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
  return capText(renderRecord(entry, options, false).join("\n"), MAX_EXCERPT_CHARS);
}

function renderMessage(message: MessageView, options: TraceRenderOptions, elideResults: boolean): string[] {
  if (message.role === "toolResult") {
    const flag = message.isError ? " error" : "";
    const name = message.toolName ?? "tool";
    const content = contentText(message.parts);
    if (!elideResults) return [`toolResult ${name}${flag}: ${capText(content, MAX_EXCERPT_CHARS)}`];
    const line = capText(content, message.isError ? MAX_ERROR_LINE_CHARS : MAX_RESULT_LINE_CHARS);
    const elided = content.length > line.length ? ` — ${content.length} chars in full, read the trace file for it` : "";
    return [`toolResult ${name}${flag}: ${line}${elided}`];
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
