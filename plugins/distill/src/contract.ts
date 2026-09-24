import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isValidManagedSkillName } from "./skill-rules";
import { JQ_DEFAULT_MAX_CHARS } from "./jq";
import {
  DEFAULT_SECTION_RECORDS,
  excerptFor,
  MAX_SECTION_CHARS,
  MAX_SECTION_RECORDS,
  type Trace,
  type TraceBundle,
  type TraceRenderOptions,
} from "./trace";

/**
 * The answer contract: the plugin-owned shape of the evaluator's answer — the
 * `propose_lessons` tool's schema and description — plus the mechanical instructions
 * that ride with it. Its version tracks that schema alone, never the plugin's releases,
 * and it is recorded in the ledger as provenance (D15, ADR-0008).
 *
 * The project's own `evaluator.md` holds taste; nothing mechanical belongs there, so the
 * file an operator edits never goes stale against the loop.
 */

export const ANSWER_CONTRACT_VERSION = 1;
/** A body longer than this is refused: the four parts fit in a few lines, and every extra one is noise. */
export const MAX_LESSON_BODY_CHARS = 1_200;
export const PROPOSE_LESSONS_TOOL = "propose_lessons";
export const GET_TRACE_TOOL = "get_trace";

/**
 * Where a lesson can be written. Each kind names one OMP surface, and `target` names the
 * thing inside it:
 *
 * - `skill` — `.omp/skills/<target>/SKILL.md`, patched when it exists and minted when not.
 * - `skill_reference` — `.omp/skills/<slug>/references/<name>.md` for a sub-problem of a
 *   skill, plus the line pointing at it from that skill's `SKILL.md`.
 * - `rule` — `.omp/rules/<target>.md`, a TTSR rule; `applies_to` says what fires it.
 * - `agent_prompt` — `.omp/agents/<target>.md`, an existing subagent prompt.
 * - `append_system` — `.omp/APPEND_SYSTEM.md`, the project's permanent main-agent layer.
 */
export type LessonKind = "skill" | "skill_reference" | "rule" | "agent_prompt" | "append_system";

export interface ProposedLesson {
  kind: LessonKind;
  title: string;
  body: string;
  /** What the lesson writes into; its form depends on `kind` (see the tool description). */
  target: string;
  /** Rules only: what fires the rule. Absent means the agent pulls it in by description. */
  applies_to?: string;
  /**
   * Lines to take out of the target file, quoted as the evaluator read them. A lesson that carries
   * this trims rather than appends: the quoted lines go, and `body` — if it has one — stands where
   * they were. For a surface that has grown past what a session needs, this is the lesson.
   */
  removes?: string;
  rationale: string;
  /** Qualified record ids, `trace:record`. */
  citations: string[];
}

export interface EvaluatorAnswer {
  verdict: string;
  lessons: ProposedLesson[];
}

const LESSON_KINDS: readonly LessonKind[] = ["skill", "skill_reference", "rule", "agent_prompt", "append_system"];

/** The one literal target `append_system` accepts. */
export const APPEND_SYSTEM_TARGET = "APPEND_SYSTEM.md";

export const PROPOSE_LESSONS_DESCRIPTION = [
  `Submit your judgement by calling this tool once, as your final action. It is the only way your answer is recorded: a run that ends without it is a failed run, not an empty one.`,
  ``,
  `verdict: one line stating what this session taught, or why nothing in it is worth keeping.`,
  `lessons: the lessons worth keeping, or [] when the session teaches nothing reusable. One lesson is one durable instruction for future agent sessions in this project.`,
  ``,
  `A body carries three things, in this order: the problem (what goes wrong), the one moment in this session where it bit (the command, file or edit, and what it returned), and the instruction. Three to six lines, at most ${MAX_LESSON_BODY_CHARS} characters. The instance is the point: a lesson that states a rule nothing is anchored to is one nobody recognises when they are standing in it.`,
  `rationale: why the fix must be applied — the cost of skipping it next time — and what makes this true. The reviewer reads it before deciding, so it is yours to argue in; it is never a note about which kind or target you chose.`,
  ``,
  `removes: lines to take *out* of the target file — a rule that no longer holds, the same instruction twice, a stale workaround, a paragraph that costs more than it returns. Quote them as you read them; the plugin finds those lines ignoring indentation and removes exactly them, putting the body where they were (leave the body empty to remove and add nothing). A surface that has grown bloated is a lesson: trim it rather than adding to it.`,
  ``,
  `Evidence. Every lesson cites records you read with \`get_trace\`, as \`trace:record\` — the trace id from the payload, the record id from the section's brackets. Cite the records where the failure or the correction actually happened: a lesson whose citations do not show it is not grounded, and the reviewer sees the mismatch. A citation that does not resolve against the session is rejected with an error and you are asked again: invented evidence never reaches review. Never paste a record into the body — the plugin extracts the cited records' own text verbatim for the reviewer, so the body names the moment in a clause and moves on.`,'',
  `Tool results are summarised: their first line and total size, not their output. Each trace names the transcript file on disk; its records are the session's own words, so prefer reading them with \`get_trace\` over pulling a whole transcript.`,
  ``,
  `Where a lesson goes. Pick the narrowest surface that will hold it, and edit before you add:`,
  `a file that already says something close is patched, never duplicated.`,
  ``,
  `- \`skill\` — a behaviour, workaround or well-defined problem. \`target\` is the skill's slug`,
  `  (lowercase letters, digits and hyphens). The plugin appends to .omp/skills/<target>/SKILL.md`,
  `  when it exists and mints it when it does not, so read .omp/skills/ first and reuse a slug`,
  `  whenever one covers the ground.`,
  `- \`skill_reference\` — a sub-problem of a skill that is not always encountered. \`target\` is`,
  `  "<skill-slug>/<reference-name>". The reference lands in .omp/skills/<slug>/references/, and the`,
  `  skill's SKILL.md gains the line pointing at it; the skill stays the entry point.`,
  `- \`rule\` — behaviour that can be stated exactly for a situation you can name. \`target\` is the`,
  `  rule's name and \`applies_to\` says what fires it:`,
  `    "always"            — every request, full text injected (the loudest rule; use it sparingly)`,
  `    "globs:<glob>"      — work on paths matching, e.g. "globs:**/*.sql"`,
  `    "condition:<regex>" — the stream matches, e.g. "condition:\\bterraform apply\\b"`,
  `    "ast:<pattern>"     — an edit or write whose payload matches an ast-grep pattern`,
  `    "agent:<name>"      — one agent, e.g. "agent:main" or a subagent's name`,
  `    absent              — listed by description; the agent pulls it in when it looks relevant`,
  `  Prefer the narrowest trigger that is exact: an "always" rule nobody needs is context every`,
  `  request pays for.`,
  `- \`agent_prompt\` — the behaviour belongs to a subagent. \`target\` is its name under`,
  `  .omp/agents/; that file must already exist, and the body is appended to it.`,
  `- \`append_system\` — something permanent the main agent must always respect. \`target\` is`,
  `  "${APPEND_SYSTEM_TARGET}". It rides every request in this project, so reserve it for the few`,
  `  instructions that must never be missed; anything occasional belongs in a skill or a rule.`,
  ``,
  `Before proposing anything, read .omp/distill/lessons/ — a lesson already denied for the same proposal must not be proposed again.`,
].join("\n");

export const GET_TRACE_DESCRIPTION = [
  `Read a section of one of the session's traces: by record range, or by pattern. The payload is an inventory — each trace with the records it holds, its size and its file — and this tool is how the records themselves are read. Nothing else is rendered for you.`,
  ``,
  `- trace — the id from a "## trace <id>" line in the payload.`,
  `- from / to — 1-based record ordinals, inclusive. With neither, reading starts at record 1.`,
  `- pattern — case-insensitive substring; only matching records are considered, and from/to go on counting record ordinals.`,
  `- limit — records per call: ${DEFAULT_SECTION_RECORDS} by default, at most ${MAX_SECTION_RECORDS}.`,
  `- jq — a jq filter run over that trace's records, one JSON record per line, after branch resolution. Each record is a separate input, so write the filter over a record — \`select(...)\` — and never \`.[] |\`. Use it for exact structure that a rendered section only summarises:`,
  `    all calls to one tool:      [.message.content[]? | select(.type=="toolCall") | select(.name=="edit") | .arguments.path]`,
  `    every prompt:               select(.message.role=="user") | .message.content[]?.text`,
  `    how many results failed:    [select(.message.isError == true)] | length`,
  `  Its output is capped at ${JQ_DEFAULT_MAX_CHARS} characters and a filter that runs long is stopped; jq's module loader is disabled, so include/import will not work.`,
  ``,
  `A section stops at ${MAX_SECTION_CHARS} characters or at the record limit — whichever comes first — and says where to continue, so read as much as the judgement needs and no more. Every section line carries the record's id in brackets: those are the ids a lesson cites, and a lesson may only cite records you have actually read.`,
].join("\n");

export const GET_TRACE_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["trace"],
  properties: {
    trace: { type: "string", description: 'The trace id from the payload, e.g. "01a0d2ea".' },
    from: { type: "number", description: "First record ordinal to return (1-based)." },
    to: { type: "number", description: "Last record ordinal to return, inclusive." },
    pattern: { type: "string", description: "Case-insensitive substring; only matching records are returned." },
    jq: {
      type: "string",
      description:
        'A jq filter over that trace\'s records (one JSON per line), e.g. \'[.message.content[]? | select(.type=="toolCall") | .name]\'. Exact extraction; output is capped.',
    },
    limit: {
      type: "number",
      description: `Records per call (default ${DEFAULT_SECTION_RECORDS}, max ${MAX_SECTION_RECORDS}).`,
    },
  },
};

export const PROPOSE_LESSONS_PARAMETERS: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "lessons"],
  properties: {
    verdict: {
      type: "string",
      description: "One line: what this session taught, or why nothing in it is worth learning.",
    },
    lessons: {
      type: "array",
      description: "The lessons worth keeping. Empty when the session teaches nothing reusable.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "title", "body", "target", "rationale", "citations"],
        properties: {
          kind: { type: "string", enum: [...LESSON_KINDS], description: "What the lesson writes into." },
          title: { type: "string", description: "Short title, shown in review and in the ledger." },
          body: {
            type: "string",
            description:
              `The lesson itself, self-contained: the problem, the one moment in this session where it bit, then the instruction — in that order, at most ${MAX_LESSON_BODY_CHARS} characters. Never a paste of the trace.`,
          },
          target: {
            type: "string",
            description:
              "skill: the skill slug. skill_reference: \"<skill-slug>/<reference-name>\". rule: the rule's name. agent_prompt: the agent's name under .omp/agents/. append_system: exactly \"APPEND_SYSTEM.md\".",
          },
          applies_to: {
            type: "string",
            description:
              "Rules only: what fires the rule. \"always\", \"globs:**/*.sql\", \"condition:<regex>\", \"ast:<pattern>\", or \"agent:<name>\". Omit and the rule is listed by description only.",
          },
          removes: {
            type: "string",
            description:
              "Lines to take out of the target file, quoted as read. The body stands where they were; empty body removes without adding.",
          },
          rationale: {
            type: "string",
            description:
              "Why the fix must be applied — the cost of skipping it — and what makes this true. Read by the reviewer, never written to the surface.",
          },
          citations: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description: "Qualified record ids, `trace:record`, copied from the payload's brackets.",
          },
        },
      },
    },
  },
};

export type AppliesTo =
  | { kind: "always" }
  | { kind: "globs"; value: string }
  | { kind: "condition"; value: string }
  | { kind: "ast"; value: string }
  | { kind: "agent"; value: string };

/** The rule trigger grammar the tool description documents; `undefined` means "no trigger". */
export function parseAppliesTo(value: string): AppliesTo | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (trimmed === "always") return { kind: "always" };
  const separator = trimmed.indexOf(":");
  if (separator === -1) return undefined;
  const prefix = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1).trim();
  if (rest === "") return undefined;
  switch (prefix) {
    case "globs":
      return { kind: "globs", value: rest };
    case "condition":
      return { kind: "condition", value: rest };
    case "ast":
      return { kind: "ast", value: rest };
    case "agent":
      return isValidManagedSkillName(rest) ? { kind: "agent", value: rest } : undefined;
    default:
      return undefined;
  }
}

/** Per-kind target shapes, checked before a lesson reaches review so the model can fix it. */
export function targetProblems(kind: LessonKind, target: string): string[] {
  if (kind === "append_system") {
    return target === APPEND_SYSTEM_TARGET ? [] : [`target must be exactly "${APPEND_SYSTEM_TARGET}"`];
  }
  if (kind === "skill_reference") {
    const parts = target.split("/");
    if (parts.length !== 2 || !parts.every(part => isValidManagedSkillName(part))) {
      return ['target must be "<skill-slug>/<reference-name>", both lowercase letters, digits and hyphens'];
    }
    return [];
  }
  return isValidManagedSkillName(target)
    ? []
    : [
        kind === "rule"
          ? "target must be a rule name: lowercase letters, digits and hyphens"
          : kind === "agent_prompt"
            ? "target must be an agent name: lowercase letters, digits and hyphens"
            : "target must be a skill slug: lowercase letters, digits and hyphens",
      ];
}

export function parseCitation(citation: string): { traceId: string; recordId: string } | undefined {
  const separator = citation.lastIndexOf(":");
  if (separator <= 0 || separator === citation.length - 1) return undefined;
  const traceId = citation.slice(0, separator).trim();
  const recordId = citation.slice(separator + 1).trim();
  if (traceId === "" || recordId === "") return undefined;
  return { traceId, recordId };
}

export type AnswerParse = { ok: true; answer: EvaluatorAnswer } | { ok: false; error: string };

/** Validates the tool call's arguments. Structure only; citations resolve separately. */
export function parseAnswer(raw: unknown): AnswerParse {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "the answer must be an object with `verdict` and `lessons`" };
  }
  const record = raw as Record<string, unknown>;

  const verdict = typeof record.verdict === "string" ? record.verdict.trim() : "";
  if (verdict === "") errors.push("`verdict` must be a non-empty one-line summary");

  if (!Array.isArray(record.lessons)) {
    errors.push("`lessons` must be an array (empty when the session teaches nothing)");
    return { ok: false, error: errors.join("; ") };
  }

  const lessons: ProposedLesson[] = [];
  record.lessons.forEach((item, index) => {
    const where = `lessons[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const lesson = item as Record<string, unknown>;
    const kind = typeof lesson.kind === "string" ? (lesson.kind as LessonKind) : undefined;
    if (!kind || !LESSON_KINDS.includes(kind)) {
      errors.push(`${where}.kind must be one of ${LESSON_KINDS.join(", ")}`);
      return;
    }
    const strings: Record<string, string> = {};
    for (const field of ["title", "body", "target", "rationale"] as const) {
      const value = typeof lesson[field] === "string" ? (lesson[field] as string).trim() : "";
      if (value === "") errors.push(`${where}.${field} must be a non-empty string`);
      strings[field] = value;
    }
    if ((strings.body ?? "").length > MAX_LESSON_BODY_CHARS) {
      errors.push(
        `${where}.body is ${(strings.body ?? "").length} characters; keep it under ${MAX_LESSON_BODY_CHARS} — problem, instance, instruction, cost, and nothing else`,
      );
    }
    for (const problem of targetProblems(kind, strings.target ?? "")) errors.push(`${where}.${problem}`);
    const removes = typeof lesson.removes === "string" ? lesson.removes.trim() : undefined;
    if (removes !== undefined && removes === "") errors.push(`${where}.removes was given as empty text; omit it instead`);
    const appliesTo = typeof lesson.applies_to === "string" ? lesson.applies_to.trim() : undefined;
    if (appliesTo !== undefined && appliesTo !== "" && !parseAppliesTo(appliesTo)) {
      errors.push(
        `${where}.applies_to must be "always", "globs:<glob>", "condition:<regex>", "ast:<pattern>" or "agent:<name>"`,
      );
    }
    const citations = Array.isArray(lesson.citations) ? lesson.citations.filter((c): c is string => typeof c === "string") : [];
    if (citations.length === 0) {
      errors.push(`${where}.citations must name at least one record from the payload`);
    } else {
      for (const citation of citations) {
        if (!parseCitation(citation)) errors.push(`${where}.citations has a malformed id: ${citation}`);
      }
    }
    lessons.push({
      kind,
      title: strings.title ?? "",
      body: strings.body ?? "",
      target: strings.target ?? "",
      ...(appliesTo === undefined || appliesTo === "" ? {} : { applies_to: appliesTo }),
      ...(removes === undefined || removes === "" ? {} : { removes }),
      rationale: strings.rationale ?? "",
      citations,
    });
  });

  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  return { ok: true, answer: { verdict, lessons } };
}

export interface ResolvedCitation {
  citation: string;
  recordId: string;
  trace: Trace;
  record: SessionEntry;
  excerpt: string;
}

export type CitationResolution =
  | { ok: true; resolved: ResolvedCitation[] }
  | { ok: false; errors: string[] };

/**
 * A citation that does not resolve against the payload is the model's mistake to fix
 * inside the run: it comes back as a tool error, and no lesson reaches review.
 */
export function resolveCitations(
  lesson: Pick<ProposedLesson, "citations">,
  bundle: TraceBundle,
  options: TraceRenderOptions = { includeThinking: true },
): CitationResolution {
  const traces = new Map(bundle.traces.map(trace => [trace.id, trace]));
  const resolved: ResolvedCitation[] = [];
  const errors: string[] = [];

  for (const citation of lesson.citations) {
    const parsed = parseCitation(citation);
    if (!parsed) {
      errors.push(`${citation} is not a qualified id; use trace:record`);
      continue;
    }
    const trace = traces.get(parsed.traceId);
    if (!trace) {
      errors.push(`${citation} names trace ${parsed.traceId}, which is not in this payload (${[...traces.keys()].join(", ")})`);
      continue;
    }
    const record = trace.records.find(entry => entry.id === parsed.recordId);
    if (!record) {
      errors.push(`${citation} names record ${parsed.recordId}, which trace ${parsed.traceId} does not contain`);
      continue;
    }
    resolved.push({ citation, recordId: parsed.recordId, trace, record, excerpt: excerptFor(record, options) });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, resolved };
}

/**
 * A lesson's identity: the proposal's shape, normalized, hashed. The same proposal
 * arriving twice collides deliberately, so a denied lesson cannot be re-proposed as if
 * it were new.
 */
export function lessonId(lesson: Pick<ProposedLesson, "kind" | "title" | "body" | "target">): string {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const material = [lesson.kind, normalize(lesson.target), normalize(lesson.title), normalize(lesson.body)].join("\n");
  return new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 12);
}
