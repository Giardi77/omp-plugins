import { describe, expect, test } from "bun:test";
import { loadSession, resolveBranch } from "../src/store";
import { buildBundle } from "../src/trace";
import {
  ANSWER_CONTRACT_VERSION,
  MAX_LESSON_BODY_CHARS,
  parseAppliesTo,
  type ProposedLesson,
  targetProblems,
  lessonId,
  parseAnswer,
  parseCitation,
  PROPOSE_LESSONS_DESCRIPTION,
  PROPOSE_LESSONS_PARAMETERS,
  PROPOSE_LESSONS_TOOL,
  resolveCitations,
} from "../src/contract";
import { assistantMessage, entriesOf, makeTempDir, textPart, userMessage, writeSessionFixture } from "./fixtures";

const SESSION_ID = "abc12345-1111-7000-8000-000000000020";

async function fixtureBundle() {
  const dir = await makeTempDir("omp-distill-contract-");
  const cwd = "/work/alpha";
  const sessionPath = await writeSessionFixture({
    dir,
    sessionId: SESSION_ID,
    cwd,
    lines: [
      userMessage({ id: "aaaa0001", parentId: null }, "the retry helper sleeps too little"),
      assistantMessage({ id: "aaaa0002", parentId: "aaaa0001" }, [textPart("raised it to 250ms")]),
    ],
  });
  const loaded = await loadSession(sessionPath);
  if (!loaded.ok) throw new Error(loaded.reason);
  return buildBundle({
    projectRoot: cwd,
    sessionId: loaded.session.header.id,
    sessionFile: sessionPath,
    parent: resolveBranch(loaded.session.entries),
    subagents: [],
  });
}

const validLesson: ProposedLesson = {
  kind: "skill",
  title: "Wait longer between retries",
  body: "Sleep at least 250ms between retry attempts; 100ms flaps under CI load.",
  target: "retry-helper",
  rationale: "The session shows the flake disappearing once the sleep grew.",
  citations: ["abc12345:aaaa0002"],
};

describe("the propose_lessons contract", () => {
  test("is the schema and the mechanical instructions, versioned by shape", () => {
    expect(PROPOSE_LESSONS_TOOL).toBe("propose_lessons");
    expect(ANSWER_CONTRACT_VERSION).toBe(1);

    const schema = PROPOSE_LESSONS_PARAMETERS as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<
        string,
        { enum?: string[]; minItems?: number; items?: { required?: string[]; properties?: Record<string, unknown> } }
      >;
    };
    expect(schema.required).toEqual(["verdict", "lessons"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.lessons?.items?.required).toEqual([
      "kind",
      "title",
      "body",
      "target",
      "rationale",
      "citations",
    ]);
    expect(schema.properties.lessons?.items?.properties?.citations).toBeDefined();

    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("once, as your final action");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("trace:record");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain(".omp/distill/lessons/");
    // A lesson that reads well is the point: the body's four parts, in order, and the cap.
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("the problem (what goes wrong)");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain(`at most ${MAX_LESSON_BODY_CHARS} characters`);
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("why the fix must be applied");
    // Grounding: the citations have to be the moment the lesson came from.
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("citations do not show it is not grounded");
  });

  test("every surface OMP offers is a kind, and each kind checks its target", () => {
    const schema = PROPOSE_LESSONS_PARAMETERS as { properties: { lessons?: { items?: { properties?: Record<string, { enum?: string[] }> } } } };
    expect(schema.properties.lessons?.items?.properties?.kind?.enum).toEqual([
      "skill",
      "skill_reference",
      "rule",
      "agent_prompt",
      "append_system",
    ]);
    expect(schema.properties.lessons?.items?.properties?.applies_to).toBeDefined();

    expect(targetProblems("skill", "retry-backoff")).toEqual([]);
    expect(targetProblems("rule", "Bad Name")).toHaveLength(1);
    expect(targetProblems("agent_prompt", "reviewer")).toEqual([]);
    expect(targetProblems("skill_reference", "retry-helper/ci-load")).toEqual([]);
    expect(targetProblems("skill_reference", "retry-helper")).toHaveLength(1);
    expect(targetProblems("skill_reference", "retry-helper/ci/load")).toHaveLength(1);
    expect(targetProblems("append_system", "APPEND_SYSTEM.md")).toEqual([]);
    expect(targetProblems("append_system", "RULES.md")).toHaveLength(1);
  });

  test("a rule's trigger is one of the host's own shapes, or nothing", () => {
    expect(parseAppliesTo("always")).toEqual({ kind: "always" });
    expect(parseAppliesTo("globs:**/*.sql")).toEqual({ kind: "globs", value: "**/*.sql" });
    expect(parseAppliesTo("condition:\bterraform apply\b")).toEqual({ kind: "condition", value: "\bterraform apply\b" });
    expect(parseAppliesTo("ast:$A + $B")).toEqual({ kind: "ast", value: "$A + $B" });
    expect(parseAppliesTo("agent:reviewer")).toEqual({ kind: "agent", value: "reviewer" });
    expect(parseAppliesTo("")).toBeUndefined();

    for (const bad of ["sometimes", "globs:", "globs: ", "agent:Bad Name", "whenever I feel like it"]) {
      expect(parseAppliesTo(bad)).toBeUndefined();
    }
  });

  test("accepts a well-formed answer, including an empty one", () => {
    const accepted = parseAnswer({ verdict: "nothing reusable here", lessons: [] });
    expect(accepted.ok).toBe(true);

    const withLesson = parseAnswer({ verdict: "one lesson", lessons: [validLesson] });
    expect(withLesson.ok).toBe(true);
    if (!withLesson.ok) return;
    expect(withLesson.answer.lessons[0]).toEqual(validLesson);
  });

  test("refuses a malformed answer with a message the model can act on", () => {
    const cases: Array<[unknown, string]> = [
      ["not an object", "must be an object"],
      [{ lessons: [] }, "verdict"],
      [{ verdict: "x" }, "lessons"],
      [{ verdict: "x", lessons: [{ ...validLesson, kind: "rewrite_everything" }] }, "kind must be one of"],
      [{ verdict: "x", lessons: [{ ...validLesson, body: "   " }] }, "body must be a non-empty string"],
      [
        { verdict: "x", lessons: [{ ...validLesson, body: "x".repeat(MAX_LESSON_BODY_CHARS + 1) }] },
        "keep it under",
      ],
      [{ verdict: "x", lessons: [{ ...validLesson, citations: [] }] }, "citations must name at least one"],
      [{ verdict: "x", lessons: [{ ...validLesson, citations: ["not-a-qualified-id"] }] }, "malformed id"],
      [{ verdict: "x", lessons: [{ ...validLesson, target: "Bad Name" }] }, "target must be a skill slug"],
      [{ verdict: "x", lessons: [{ ...validLesson, kind: "rule", target: "fine", applies_to: "whenever" }] }, "applies_to must be"],
    ];

    for (const [input, expected] of cases) {
      const result = parseAnswer(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain(expected);
    }
  });

  test("citations are qualified ids", () => {
    expect(parseCitation("abc12345:aaaa0002")).toEqual({ traceId: "abc12345", recordId: "aaaa0002" });
    expect(parseCitation("abc12345")).toBeUndefined();
    expect(parseCitation(":aaaa0002")).toBeUndefined();
    expect(parseCitation("abc12345:")).toBeUndefined();
  });
});

describe("citation resolution", () => {
  test("resolves cited records to their excerpts", async () => {
    const bundle = await fixtureBundle();
    const resolution = resolveCitations({ citations: ["abc12345:aaaa0002"] }, bundle);

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.resolved[0]?.recordId).toBe("aaaa0002");
    expect(resolution.resolved[0]?.excerpt).toBe("assistant: raised it to 250ms");
    expect(resolution.resolved[0]?.trace.label).toBe("parent session");
  });

  test("an unresolvable citation is an error naming what was wrong", async () => {
    const bundle = await fixtureBundle();

    const unknownTrace = resolveCitations({ citations: ["99999999:aaaa0002"] }, bundle);
    expect(unknownTrace.ok).toBe(false);
    if (!unknownTrace.ok) expect(unknownTrace.errors[0]).toContain("is not in this payload");

    const unknownRecord = resolveCitations({ citations: ["abc12345:deadbeef"] }, bundle);
    expect(unknownRecord.ok).toBe(false);
    if (!unknownRecord.ok) expect(unknownRecord.errors[0]).toContain("does not contain");
  });
});

describe("lesson identity", () => {
  test("is stable under case and whitespace, and distinct for different bodies", () => {
    const id = lessonId(validLesson);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(lessonId({ ...validLesson, body: `  ${validLesson.body.toUpperCase()}  ` })).toBe(id);
    expect(lessonId({ ...validLesson, body: "a different lesson" })).not.toBe(id);
    expect(lessonId({ ...validLesson, target: "other-skill" })).not.toBe(id);
  });

  test("fixture entries stay parseable for the bundle builder", () => {
    expect(entriesOf([userMessage({ id: "aaaa0001", parentId: null }, "x")])[0]?.id).toBe("aaaa0001");
  });
});
