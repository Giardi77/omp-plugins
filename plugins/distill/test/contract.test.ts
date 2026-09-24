import { describe, expect, test } from "bun:test";
import { loadSession, resolveBranch } from "../src/store";
import { buildBundle } from "../src/trace";
import {
  ANSWER_CONTRACT_VERSION,
  INTERRUPT_MODES,
  MAX_LESSON_BODY_CHARS,
  parseAppliesTo,
  readAppliesTo,
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
    // 2 since `removes`: an answer from before it and one after are different shapes. 3 since
    // `applies_to` became a clause list: the same field now carries the trigger and its delivery
    // (ADR-0016, ADR-0019).
    expect(ANSWER_CONTRACT_VERSION).toBe(3);

    const schema = PROPOSE_LESSONS_PARAMETERS as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<
        string,
        { enum?: string[]; minItems?: number; items?: { required?: string[]; properties?: Record<string, { description?: string }> } }
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

    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("It is the only way your answer is recorded");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("call `tasks_completed`");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("trace:record");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain(".omp/distill/lessons/");
    // A lesson that reads well is the point: the body's four parts, in order, and the cap.
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("the problem (what goes wrong)");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain(`at most ${MAX_LESSON_BODY_CHARS} characters`);
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("why the fix must be applied");
    // Grounding: the citations have to be the moment the lesson came from.
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("citations do not show it is not grounded");
    // And the one exception: what is injected takes the instruction alone — its length is the
    // operator's call, in the project's own prompt (ADR-0018).
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("the body is the instruction alone");
    expect(PROPOSE_LESSONS_DESCRIPTION).toContain("stated in its own evaluator prompt");
  });

  test("a lesson may leave its body empty only when it is taking lines out", () => {
    // The natural trim — "the same rule twice, delete one" — has nothing to add, and asking the
    // model to invent replacement text is asking it to write the bloat it was sent to remove.
    const trim = parseAnswer({
      verdict: "the skill says the same thing twice",
      lessons: [{ ...validLesson, body: "", removes: "## Retry backoff (old)\n\nSleep 100ms between attempts." }],
    });
    expect(trim.ok).toBe(true);
    expect(trim.ok && trim.answer.lessons[0]?.body).toBe("");
    expect(trim.ok && trim.answer.lessons[0]?.removes).toBe("## Retry backoff (old)\n\nSleep 100ms between attempts.");

    const empty = parseAnswer({ verdict: "nothing", lessons: [{ ...validLesson, body: "  " }] });
    expect(empty.ok).toBe(false);
    expect(empty.ok || empty.error).toContain("must be a non-empty string, or `removes` the lines it takes out");

    // Whitespace-only `removes` is still not a removal.
    const blank = parseAnswer({ verdict: "nothing", lessons: [{ ...validLesson, body: "", removes: "   " }] });
    expect(blank.ok).toBe(false);
  });

  test("an injected body is not capped: the shape is the operator's call", () => {
    // The cap was written, then rejected: "no i don't like the hard cap. we can just instruct the
    // evaluator in the evaluator.md prompt". The parser holds the contract, not the taste — a rule
    // body past a few hundred characters is accepted here and caught by the reviewer, whose
    // `removes` takes it back out (ADR-0016, ADR-0018).
    const story =
      "It bit on a sweep: the brief said one request per second, the command carried no `-rl`, and it fired 81 requests in 13.31 s. ";
    const body = story.repeat(4);
    expect(body.length).toBeGreaterThan(400);

    const rule = parseAnswer({
      verdict: "cap the command, not the brief",
      lessons: [
        { ...validLesson, kind: "rule", target: "rate-cap-in-command", applies_to: "condition:\\bhttpx\\b", body },
      ],
    });

    expect(rule.ok).toBe(true);
    expect(rule.ok && rule.answer.lessons[0]?.body).toContain("81 requests");
  });

  test("a reference must open with the sentence that says what it explains", () => {
    const reference: ProposedLesson = {
      ...validLesson,
      kind: "skill_reference",
      target: "retry-helper/ci-load",
      body: "What changes when CI load makes a retry come back sooner than the sleep expects.",
    };
    expect(parseAnswer({ verdict: "one detail", lessons: [reference] })).toMatchObject({ ok: true });

    const headingFirst = parseAnswer({ verdict: "one detail", lessons: [{ ...reference, body: "## Backoff\n\nSleep 250ms." }] });
    expect(headingFirst.ok).toBe(false);
    expect(headingFirst.ok || headingFirst.error).toContain("must open with one sentence");

    // The rule is the reference's: a skill's body may open with whatever it likes.
    expect(parseAnswer({ verdict: "a skill", lessons: [validLesson] }).ok).toBe(true);

    // …and a reference being trimmed adds no line of its own, so there is nothing to open with.
    const trimmed = parseAnswer({
      verdict: "the reference says the same thing twice",
      lessons: [
        {
          ...reference,
          body: "",
          removes: "## Old note\n\nSleep at least 250ms between attempts, because CI load makes 100ms flap.",
        },
      ],
    });
    expect(trimmed.ok).toBe(true);
    expect(trimmed.ok && trimmed.answer.lessons[0]?.removes).toContain("## Old note");
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

  test("a rule's trigger is a clause list in the host's own frontmatter keys", () => {
    // One clause, as before — an old lesson and a new one write the same file.
    expect(parseAppliesTo("always")).toEqual({ trigger: { always: true }, problems: [] });
    expect(parseAppliesTo("globs:**/*.sql")).toEqual({ trigger: { globs: "**/*.sql" }, problems: [] });
    expect(parseAppliesTo("condition:\\bterraform apply\\b")).toEqual({
      trigger: { condition: "\\bterraform apply\\b" },
      problems: [],
    });
    expect(parseAppliesTo("ast:$A + $B")).toEqual({ trigger: { ast: "$A + $B" }, problems: [] });
    expect(parseAppliesTo("agent:reviewer")).toEqual({ trigger: { agent: "reviewer" }, problems: [] });
    // …and a list, which is what carries the two keys that shape a match rather than make one.
    expect(parseAppliesTo(["condition:\\bhttpx\\b", "scope:tool:bash", "interrupt:never"])).toEqual({
      trigger: { condition: "\\bhttpx\\b", scope: "tool:bash", interrupt: "never" },
      problems: [],
    });
    expect(parseAppliesTo(["always", "agent:reviewer", "globs:**/*.sql"])).toEqual({
      trigger: { always: true, agent: "reviewer", globs: "**/*.sql" },
      problems: [],
    });
    expect(parseAppliesTo(undefined)).toEqual({ problems: [] });
    expect(parseAppliesTo("  ")).toEqual({ problems: [] });
    expect(readAppliesTo(" condition:x ")).toBe("condition:x");
    expect(readAppliesTo(["condition:x", "  "])).toEqual(["condition:x"]);
    expect(readAppliesTo("   ")).toBeUndefined();
    expect(readAppliesTo(7)).toBeUndefined();

    for (const bad of ["sometimes", "globs:", "globs: ", "agent:Bad Name", "whenever I feel like it"]) {
      const parsed = parseAppliesTo(bad);
      expect(parsed.problems.length).toBe(1);
      expect(parsed.trigger ?? {}).toEqual({});
    }
  });

  test("a clause list is refused when it could not mean anything", () => {
    // Two triggers: the host's buckets are exclusive, so the second would be dead frontmatter.
    const twoTriggers = parseAppliesTo(["condition:a", "ast:b"]);
    expect(twoTriggers.problems.join(" ")).toContain("a rule fires one way");
    const alwaysAndCondition = parseAppliesTo(["always", "condition:a"]);
    expect(alwaysAndCondition.problems.join(" ")).toContain("a rule fires one way");

    // A modifier with nothing to modify: the host ignores scope on a rule that never matches.
    for (const orphan of ["scope:text", "interrupt:never", "scope:tool:edit(*.rs)"]) {
      const parsed = parseAppliesTo([orphan]);
      expect(parsed.problems.join(" ")).toContain("needs a condition:<regex> or ast:<pattern>");
    }

    // Values the host itself would drop or refuse.
    expect(parseAppliesTo("scope:has space").problems.join(" ")).toContain("is not a stream");
    expect(parseAppliesTo("interrupt:sometimes").problems.join(" ")).toContain("is not a mode");
    expect(parseAppliesTo("interrupt:nevr").problems.join(" ")).toContain("not a mode");
    expect(parseAppliesTo(["globs:a", "globs:b"]).problems.join(" ")).toContain("was given twice");

    // Valid ones, including the host's own scope vocabulary.
    for (const fine of ["scope:text", "scope:thinking", "scope:tool", "scope:toolcall", "scope:tool:bash", "scope:edit(*.rs)"]) {
      const parsed = parseAppliesTo(["condition:x", fine]);
      expect(parsed.problems).toEqual([]);
      expect(parsed.trigger?.scope).toBeDefined();
    }
    for (const mode of INTERRUPT_MODES) {
      expect(parseAppliesTo(["condition:x", `interrupt:${mode}`]).problems).toEqual([]);
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
      [{ verdict: "x", lessons: [{ ...validLesson, kind: "rule", target: "fine", applies_to: "whenever" }] }, "carries no value"],
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
