import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { excerptFor, type Trace, type TraceBundle, type TraceRenderOptions } from "./trace";

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
export const PROPOSE_LESSONS_TOOL = "propose_lessons";

export type LessonKind = "patch_skill" | "new_skill" | "agent_prompt";

export interface ProposedLesson {
  kind: LessonKind;
  title: string;
  body: string;
  /** An existing skill slug, a new slug, or an agent file stem, depending on `kind`. */
  target: string;
  rationale: string;
  /** Qualified record ids, `trace:record`. */
  citations: string[];
}

export interface EvaluatorAnswer {
  verdict: string;
  lessons: ProposedLesson[];
}

const LESSON_KINDS: readonly LessonKind[] = ["patch_skill", "new_skill", "agent_prompt"];

export const PROPOSE_LESSONS_DESCRIPTION = [
  `Submit your judgement by calling this tool once, as your final action. It is the only way your answer is recorded: a run that ends without it is a failed run, not an empty one.`,
  ``,
  `verdict: one line stating what this session taught, or why nothing in it is worth keeping.`,
  `lessons: the lessons worth keeping, or [] when the session teaches nothing reusable. One lesson is one durable instruction for future agent sessions in this project.`,
  ``,
  `Evidence. Every lesson cites records from the payload, as \`trace:record\`, copying both ids from the brackets. A citation that does not resolve is rejected with an error and you are asked again: invented evidence never reaches review. Never quote text into the body — the plugin extracts the cited records' own text verbatim, so the body stays a statement of the lesson.`,
  ``,
  `Kinds and targets:`,
  `- patch_skill — extends an existing skill. \`target\` is that skill's slug, and the body is appended to it. Prefer this: read the project's skills under .omp/skills/ first and patch what exists.`,
  `- new_skill — nothing existing covers it. \`target\` is a new slug: lowercase letters, digits and hyphens.`,
  `- agent_prompt — belongs in a subagent prompt. \`target\` is that agent's name under .omp/agents/.`,
  ``,
  `Before proposing anything, read .omp/distill/lessons/ — a lesson already denied for the same proposal must not be proposed again.`,
].join("\n");

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
              "The lesson itself, self-contained: a future agent reads it without this session. Never a quote of the trace.",
          },
          target: {
            type: "string",
            description:
              "patch_skill: the existing skill slug. new_skill: a lowercase-hyphenated slug. agent_prompt: the agent name under .omp/agents/.",
          },
          rationale: { type: "string", description: "Why this is worth keeping, in one or two sentences." },
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
