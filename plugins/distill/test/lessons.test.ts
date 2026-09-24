import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProposedLesson } from "../src/contract";
import { distillPaths, readConfig, setupProject } from "../src/config";
import {
  decideLesson,
  evaluationRecord,
  lessonFilePath,
  listLessons,
  purge,
  readLedger,
  readLesson,
  retiredTraceSessionIds,
  saveProposals,
} from "../src/lessons";
import { makeTempDir } from "./fixtures";

const proposal: ProposedLesson = {
  kind: "skill",
  title: "Wait longer between retries",
  body: "Sleep at least 250ms between retry attempts.",
  target: "retry-helper",
  rationale: "The flake disappeared once the sleep grew.",
  citations: ["abc12345:aaaa0002"],
};

const provenance = {
  sessionId: "01a0ced4-1111-7000-8000-000000000030",
  traceSessionIds: ["01a0ced4-1111-7000-8000-000000000030"],
  contractVersion: 1,
  promptSha256: "deadbeef",
};

async function store() {
  const project = path.join(await makeTempDir("omp-distill-lessons-"), "project");
  const paths = distillPaths(project);
  await setupProject(project);
  return paths;
}

function resolved(citation = "abc12345:aaaa0002") {
  return [
    {
      citation,
      recordId: citation.split(":")[1] ?? "",
      trace: {
        id: "abc12345",
        sessionId: provenance.sessionId,
        sessionFile: "/tmp/session.jsonl",
        role: "parent" as const,
        label: "parent session",
        records: [],
      },
      record: { type: "message", id: "aaaa0002", parentId: null, timestamp: "", message: {} } as never,
      excerpt: "assistant: raised the sleep to 250ms",
    },
  ];
}

describe("the lesson store", () => {
  test("records proposals with verbatim excerpts and reports duplicates", async () => {
    const paths = await store();

    const first = await saveProposals(paths, [{ lesson: proposal, resolved: resolved() }], provenance, "2026-09-24T10:00:00.000Z");
    expect(first.created).toHaveLength(1);
    expect(first.duplicates).toEqual([]);

    const id = first.created[0]?.id ?? "";
    const stored = await readLesson(paths, id);
    expect(stored?.state).toBe("proposed");
    expect(stored?.citations).toEqual([{ citation: "abc12345:aaaa0002", excerpt: "assistant: raised the sleep to 250ms" }]);
    expect(stored?.provenance.promptSha256).toBe("deadbeef");
    expect(JSON.parse(await Bun.file(lessonFilePath(paths, id)).text())).toMatchObject({ id, state: "proposed" });

    const again = await saveProposals(paths, [{ lesson: { ...proposal, body: `  ${proposal.body.toUpperCase()} ` }, resolved: resolved() }], provenance);
    expect(again.created).toEqual([]);
    expect(again.duplicates).toEqual([id]);
    expect(await listLessons(paths)).toHaveLength(1);
  });

  test("a denied lesson cannot come back as if it were new", async () => {
    const paths = await store();
    const { created } = await saveProposals(paths, [{ lesson: proposal, resolved: resolved() }], provenance);
    const id = created[0]?.id ?? "";

    const denied = await decideLesson(paths, id, { state: "denied", reason: "too obvious" }, "2026-09-24T11:00:00.000Z");
    expect(denied.state).toBe("denied");
    expect(denied.reason).toBe("too obvious");

    const replayed = await saveProposals(paths, [{ lesson: proposal, resolved: resolved() }], provenance);
    expect(replayed.created).toEqual([]);
    expect(replayed.duplicates).toEqual([id]);
    expect((await listLessons(paths, "proposed"))).toEqual([]);
  });

  test("a rule's trigger survives the proposal, so approval mints the right frontmatter", async () => {
    const paths = await store();
    const rule = { ...proposal, kind: "rule" as const, target: "sql-migrations", applies_to: "globs:**/*.sql" };

    const { created } = await saveProposals(paths, [{ lesson: rule, resolved: resolved() }], provenance);
    expect(created[0]?.applies_to).toBe("globs:**/*.sql");
    expect((await readLesson(paths, created[0]?.id ?? ""))?.applies_to).toBe("globs:**/*.sql");
  });

  test("a decision and its ledger row land together", async () => {
    const paths = await store();
    const { created } = await saveProposals(paths, [{ lesson: proposal, resolved: resolved() }], provenance);
    const id = created[0]?.id ?? "";

    await decideLesson(paths, id, { state: "approved", written: [".omp/skills/retry-helper/SKILL.md"] });
    const ledger = await readLedger(paths);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "decision",
      lessonId: id,
      decision: "approved",
      written: [".omp/skills/retry-helper/SKILL.md"],
    });
    expect((await readLesson(paths, id))?.written).toEqual([".omp/skills/retry-helper/SKILL.md"]);
  });
});

describe("eligibility", () => {
  test("an empty run is recorded as a failure with reason empty, and still retires its traces", async () => {
    const paths = await store();
    const session = "01a0ced4-1111-7000-8000-000000000031";

    await Bun.write(
      paths.decisionsPath,
      `${JSON.stringify(evaluationRecord({ ...provenance, sessionId: session, sessionFile: "/tmp/s.jsonl", traceSessionIds: [session, "01a0ced4-2222-7000-8000-000000000032"], outcome: "empty", verdict: "nothing durable", promptSha256: "x" }))}\n`,
    );

    const [record] = await readLedger(paths);
    expect(record).toMatchObject({ kind: "evaluation", outcome: "failed", reason: "empty", verdict: "nothing durable" });

    const covered = await retiredTraceSessionIds(paths);
    expect(covered.has(session)).toBe(true);
    expect(covered.has("01a0ced4-2222-7000-8000-000000000032")).toBe(true);
    expect(covered.size).toBe(2);
  });

  test("a technical fault leaves its traces eligible", async () => {
    const paths = await store();
    const session = "01a0ced4-1111-7000-8000-000000000033";

    await Bun.write(
      paths.decisionsPath,
      `${JSON.stringify(evaluationRecord({ ...provenance, sessionId: session, sessionFile: "/tmp/s.jsonl", traceSessionIds: [session], outcome: "failed", reason: "exceeded the 600s deadline", promptSha256: "x" }))}\n`,
    );

    expect(await retiredTraceSessionIds(paths)).toEqual(new Set());
    expect((await readLedger(paths))[0]).toMatchObject({ outcome: "failed", reason: "exceeded the 600s deadline" });
  });
});

describe("purge", () => {
  test("deletes distill's copies and names the files it left alone", async () => {
    const paths = await store();
    const { created } = await saveProposals(paths, [{ lesson: proposal, resolved: resolved() }], provenance);
    const id = created[0]?.id ?? "";
    await decideLesson(paths, id, { state: "approved", written: [".omp/skills/retry-helper/SKILL.md"] });
    await Bun.write(path.join(paths.tmpDir, "dump.txt"), "failure dump\n");
    const skillPath = path.join(paths.projectRoot, ".omp", "skills", "retry-helper", "SKILL.md");
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await Bun.write(skillPath, "# kept\n");

    const result = await purge(paths);

    expect(result.lessonsRemoved).toBe(1);
    expect(result.decisionsRemoved).toBe(1);
    expect(result.leftAlone).toEqual([".omp/skills/retry-helper/SKILL.md"]);
    expect(await listLessons(paths)).toEqual([]);
    expect(await readLedger(paths)).toEqual([]);
    expect(await fs.stat(paths.lessonsDir).catch(() => undefined)).toBeUndefined();
    expect(await Bun.file(skillPath).text()).toBe("# kept\n");
    expect(await readConfig(paths)).toBeDefined();
  });
});
