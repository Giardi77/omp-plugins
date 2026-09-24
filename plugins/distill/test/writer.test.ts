import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { distillPaths, setupProject, type DistillPaths } from "../src/config";
import type { StoredLesson } from "../src/lessons";
import { applyWrite, planWrite } from "../src/writer";
import { makeTempDir } from "./fixtures";

function lesson(overrides: Partial<StoredLesson> = {}): StoredLesson {
  return {
    id: "abcdef123456",
    state: "approved",
    kind: "skill",
    title: "Wait longer between retries",
    body: "Sleep at least 250ms between retry attempts.",
    target: "retry-helper",
    rationale: "The flake disappeared once the sleep grew.",
    citations: [{ citation: "abc12345:aaaa0002", excerpt: "assistant: raised the sleep" }],
    createdAt: "2026-09-24T10:00:00.000Z",
    provenance: {
      sessionId: "01a0ced4-1111-7000-8000-000000000040",
      traceSessionIds: ["01a0ced4-1111-7000-8000-000000000040"],
      contractVersion: 1,
      promptSha256: "x",
    },
    ...overrides,
  };
}

async function project(): Promise<DistillPaths> {
  const root = await makeTempDir("omp-distill-writer-");
  const paths = distillPaths(path.join(root, "project"));
  await setupProject(paths.projectRoot);
  return paths;
}

async function writeFile(filePath: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
  return filePath;
}

const skillPath = (paths: DistillPaths, name: string) => path.join(paths.projectRoot, ".omp", "skills", name, "SKILL.md");

describe("skills", () => {
  test("an existing slug is patched with the lesson, undecorated", async () => {
    const paths = await project();
    const filePath = await writeFile(skillPath(paths, "retry-helper"), "---\nname: retry-helper\ndescription: Retries\n---\n\nHand-written prose.\n");

    const plan = await planWrite(paths, lesson(), new Date("2026-09-24T12:00:00.000Z"));

    expect(plan.target).toBe("retry-helper");
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]?.mode).toBe("append");
    expect(plan.writes[0]?.path).toBe(filePath);
    // The lesson's own text, undecorated: a surface the next session reads, and the ledger already
    // records which lesson wrote it and when.
    expect(plan.writes[0]?.text).toBe("Sleep at least 250ms between retry attempts.\n");
  });

  test("a missing slug is minted, with a description or not at all", async () => {
    const paths = await project();
    const minted = await planWrite(paths, lesson({ target: "retry-backoff", title: "Retry backoff is coarse" }));

    expect(minted.writes[0]?.mode).toBe("create");
    expect(minted.writes[0]?.text.startsWith("---\nname: retry-backoff\ndescription: Retry backoff is coarse\n---\n")).toBe(true);

    // The loader drops a SKILL.md with no description, silently — so the writer refuses.
    await expect(planWrite(paths, lesson({ target: "silent", title: "<><>" }))).rejects.toThrow(
      "drops a SKILL.md without one",
    );
    await expect(planWrite(paths, lesson({ target: "under_score" }))).rejects.toThrow("Invalid skill name");
  });

  test("the slug decides patch versus mint, so a proposal cannot duplicate a skill", async () => {
    const paths = await project();
    await writeFile(skillPath(paths, "retry-backoff"), "---\ndescription: Existing\n---\n");

    const plan = await planWrite(paths, lesson({ target: "retry-backoff" }));
    expect(plan.writes[0]?.mode).toBe("append");
  });
});

describe("skill references", () => {
  test("a reference is written and the skill gains the line pointing at it", async () => {
    const paths = await project();
    const filePath = await writeFile(skillPath(paths, "retry-helper"), "---\nname: retry-helper\ndescription: Retries\n---\n\nHand-written prose.\n");

    const plan = await planWrite(
      paths,
      lesson({ kind: "skill_reference", target: "retry-helper/ci-load", title: "CI load" }),
      new Date("2026-09-24T12:00:00.000Z"),
    );

    expect(plan.writes.map(write => write.mode)).toEqual(["create", "append"]);
    expect(plan.writes[0]?.path).toBe(path.join(paths.projectRoot, ".omp", "skills", "retry-helper", "references", "ci-load.md"));
    expect(plan.writes[0]?.text).toBe("# CI load\n\nSleep at least 250ms between retry attempts.\n");
    expect(plan.writes[1]?.path).toBe(filePath);
    expect(plan.writes[1]?.text).toBe("## References\n\n- [`references/ci-load.md`](references/ci-load.md) — CI load\n");
    expect(plan.writes[0]?.text).toContain("# CI load");
    expect(plan.writes[1]?.text).toContain("references/ci-load.md");

    await applyWrite(paths, plan);
    expect(await Bun.file(filePath).text()).toContain("Hand-written prose.\n\n## References\n");
  });

  test("the line continues an existing References section, and refusals are loud", async () => {
    const paths = await project();
    const filePath = await writeFile(
      skillPath(paths, "retry-helper"),
      "---\ndescription: Retries\n---\n\n## References\n\n- older.md\n",
    );

    const plan = await planWrite(paths, lesson({ kind: "skill_reference", target: "retry-helper/ci-load" }));
    expect(plan.writes[1]?.text.startsWith("- [`references/ci-load.md`]")).toBe(true);
    await applyWrite(paths, plan);
    const content = await Bun.file(filePath).text();
    expect(content).toContain("## References\n\n- older.md\n\n- [`references/ci-load.md`]");

    await expect(planWrite(paths, lesson({ kind: "skill_reference", target: "retry-helper/ci-load" }))).rejects.toThrow(
      "already exists",
    );
    await expect(planWrite(paths, lesson({ kind: "skill_reference", target: "missing-skill/thing" }))).rejects.toThrow(
      "mint the skill before its reference",
    );
    await expect(planWrite(paths, lesson({ kind: "skill_reference", target: "retry-helper" }))).rejects.toThrow(
      '"<skill-slug>/<reference-name>"',
    );
  });
});

describe("rules", () => {
  test("a rule carries its trigger in frontmatter, in the host's own keys", async () => {
    const paths = await project();

    const always = await planWrite(paths, lesson({ kind: "rule", target: "no-force-push", title: "Never force-push", applies_to: "always" }));
    expect(always.writes[0]?.text.startsWith("---\ndescription: 'Never force-push'\nalwaysApply: true\n---\n")).toBe(true);

    const scoped = await planWrite(
      paths,
      lesson({ kind: "rule", target: "sql-migrations", title: "Migrations are forward-only", applies_to: "globs:**/*.sql" }),
    );
    expect(scoped.writes[0]?.text).toContain("globs:\n  - '**/*.sql'\n---");

    const conditioned = await planWrite(
      paths,
      lesson({ kind: "rule", target: "terraform-apply", title: "Ask before applying", applies_to: "condition:\\bterraform apply\\b" }),
    );
    expect(conditioned.writes[0]?.text).toContain("condition:\n  - '\\bterraform apply\\b'\n---");

    const agentScoped = await planWrite(
      paths,
      lesson({ kind: "rule", target: "reviewer-tone", title: "Reviewer stays terse", applies_to: "agent:reviewer" }),
    );
    expect(agentScoped.writes[0]?.text).toContain("agents:\n  - 'reviewer'\n---");

    const listed = await planWrite(paths, lesson({ kind: "rule", target: "listed-only", title: "Only listed" }));
    expect(listed.writes[0]?.text).toBe("---\ndescription: 'Only listed'\n---\n\nSleep at least 250ms between retry attempts.\n");
  });

  test("a patch keeps the trigger that is already on disk, and refuses a different one", async () => {
    const paths = await project();
    const filePath = await writeFile(
      path.join(paths.projectRoot, ".omp", "rules", "no-force-push.md"),
      "---\ndescription: Never force-push\nalwaysApply: true\n---\n\nNever force-push.\n",
    );

    const agreeing = await planWrite(paths, lesson({ kind: "rule", target: "no-force-push", applies_to: "always" }));
    expect(agreeing.writes[0]?.mode).toBe("append");
    expect(agreeing.writes[0]?.text).not.toContain("alwaysApply");

    await expect(
      planWrite(paths, lesson({ kind: "rule", target: "no-force-push", applies_to: "globs:**/*.sql" })),
    ).rejects.toThrow("fired by different conditions");

    await applyWrite(paths, agreeing);
    // One blank line between the prose and the lesson: the separator is the write's, not the text's.
    expect(await Bun.file(filePath).text()).toContain("Never force-push.\n\nSleep at least 250ms between retry attempts.\n");
  });

  test("a rule name outside the allowlist is refused, and an empty title never mints a description", async () => {
    const paths = await project();
    await expect(planWrite(paths, lesson({ kind: "rule", target: "Bad Name" }))).rejects.toThrow("Invalid skill name");
    await expect(planWrite(paths, lesson({ kind: "rule", target: "empty", title: "<>" }))).rejects.toThrow(
      "never listed",
    );
  });
});

describe("agent prompts and APPEND_SYSTEM.md", () => {
  test("an agent prompt is patched, never created", async () => {
    const paths = await project();
    await expect(planWrite(paths, lesson({ kind: "agent_prompt", target: "reviewer" }))).rejects.toThrow(
      "only patches existing ones",
    );

    const agentPath = await writeFile(path.join(paths.projectRoot, ".omp", "agents", "reviewer.md"), "# Reviewer\n\nBe terse.\n");
    const plan = await planWrite(paths, lesson({ kind: "agent_prompt", target: "reviewer" }));
    expect(plan.writes[0]?.path).toBe(agentPath);
    expect(plan.writes[0]?.text).toBe("Sleep at least 250ms between retry attempts.\n");

    await expect(planWrite(paths, lesson({ kind: "agent_prompt", target: "REVIEWER!" }))).rejects.toThrow(
      "not a usable agent name",
    );
  });

  test("APPEND_SYSTEM.md is created once and appended to after that", async () => {
    const paths = await project();
    const first = await planWrite(paths, lesson({ kind: "append_system", target: "APPEND_SYSTEM.md" }));
    expect(first.writes[0]?.mode).toBe("create");
    expect(first.writes[0]?.path).toBe(path.join(paths.projectRoot, ".omp", "APPEND_SYSTEM.md"));
    await applyWrite(paths, first);

    const second = await planWrite(paths, lesson({ kind: "append_system", target: "APPEND_SYSTEM.md" }));
    expect(second.writes[0]?.mode).toBe("append");

    await expect(planWrite(paths, lesson({ kind: "append_system", target: "nope.md" }))).rejects.toThrow(
      "targets APPEND_SYSTEM.md",
    );
  });
});

describe("trimming", () => {
  const bloated = [
    "---",
    "name: retry-helper",
    "description: Retries",
    "---",
    "",
    "Retries exist.",
    "",
    "## Retry backoff",
    "",
    "Sleep at least 250ms between attempts.",
    "",
    "## Retry backoff (old)",
    "",
    "Sleep at least 250ms between attempts, because CI load makes 100ms flap.",
    "",
  ].join("\n");

  test("a lesson that quotes lines to remove plans a splice, not an append", async () => {
    const paths = await project();
    const filePath = await writeFile(skillPath(paths, "retry-helper"), bloated);
    const plan = await planWrite(
      paths,
      lesson({
        removes: "## Retry backoff (old)\n\nSleep at least 250ms between attempts, because CI load makes 100ms flap.",
        body: "Sleep at least 250ms between attempts; 100ms flaps under CI load.",
      }),
    );

    expect(plan.writes.map(write => write.mode)).toEqual(["splice"]);
    expect(plan.writes[0]?.path).toBe(filePath);
    expect(plan.writes[0]?.remove).toBe(
      "## Retry backoff (old)\n\nSleep at least 250ms between attempts, because CI load makes 100ms flap.",
    );

    await applyWrite(paths, plan);
    const content = await Bun.file(filePath).text();
    expect(content).not.toContain("(old)");
    expect(content).toContain("## Retry backoff\n\nSleep at least 250ms between attempts.\n\nSleep at least 250ms");
    // The duplicate is gone and the trimmed wording stands in its place, once.
    expect(content.match(/100ms flaps under CI load/g)).toHaveLength(1);
  });

  test("the indentation a lesson quotes does not have to match, and an empty body removes only", async () => {
    const paths = await project();
    const filePath = await writeFile(skillPath(paths, "retry-helper"), "Retries exist.\n  - stale: use the old helper\nKeep this.\n");
    const plan = await planWrite(paths, lesson({ removes: "- stale: use the old helper", body: "" }));

    await applyWrite(paths, plan);
    const content = await Bun.file(filePath).text();
    expect(content).toBe("Retries exist.\nKeep this.\n");
    expect(plan.writes[0]?.text).toBe("");
  });

  test("quoted text that is not in the file blocks the lesson rather than writing anything", async () => {
    const paths = await project();
    await writeFile(skillPath(paths, "retry-helper"), "Retries exist.\n");

    await expect(planWrite(paths, lesson({ removes: "a paragraph that was never there" }))).rejects.toThrow(
      /does not contain the text this lesson removes/,
    );
  });

  test("text that appears twice is refused: a trim names one place", async () => {
    const paths = await project();
    await writeFile(skillPath(paths, "retry-helper"), "Same line.\nOther.\nSame line.\n");
    await expect(planWrite(paths, lesson({ removes: "Same line.", body: "" }))).rejects.toThrow(
      /appears 2 times/,
    );
  });

  test("a trim of a file that does not exist yet is refused, not turned into a create", async () => {
    const paths = await project();
    await expect(planWrite(paths, lesson({ kind: "rule", target: "brand-new", removes: "anything" }))).rejects.toThrow(
      /does not exist yet/,
    );
  });
});

describe("applying a write", () => {
  test("a patch appends after the hand-written prose and leaves it intact", async () => {
    const paths = await project();
    const original = "---\nname: retry-helper\ndescription: Retries\n---\n\nHand-written prose.\n";
    const filePath = await writeFile(skillPath(paths, "retry-helper"), original);

    const result = await applyWrite(paths, await planWrite(paths, lesson()));

    const content = await Bun.file(filePath).text();
    expect(content.startsWith(original)).toBe(true);
    expect(content).toContain("Hand-written prose.\n\nSleep at least 250ms between retry attempts.\n");
    expect(result.written).toEqual([filePath]);
  });

  test("a mint creates the skill once", async () => {
    const paths = await project();
    const plan = await planWrite(paths, lesson({ target: "retry-backoff" }));
    const result = await applyWrite(paths, plan);

    expect(result.written).toEqual([skillPath(paths, "retry-backoff")]);
    expect(await Bun.file(result.written[0] ?? "").text()).toBe(plan.writes[0]?.text);
    await expect(applyWrite(paths, plan)).rejects.toThrow();
  });

  test("the size cap is enforced on the final file, before anything is written", async () => {
    const paths = await project();
    const padding = "x".repeat(63_000);
    const filePath = await writeFile(skillPath(paths, "retry-helper"), `---\nname: retry-helper\ndescription: Retries\n---\n\n${padding}\n`);

    const plan = await planWrite(paths, lesson({ body: "y".repeat(2_000) }));
    await expect(applyWrite(paths, plan)).rejects.toThrow("over the 64000-byte cap");
    expect((await Bun.file(filePath).text()).endsWith(`${padding}\n`)).toBe(true);
  });

  test("a mint over the cap leaves nothing behind", async () => {
    const paths = await project();
    const plan = await planWrite(paths, lesson({ target: "retry-backoff", body: "y".repeat(64_001) }));

    await expect(applyWrite(paths, plan)).rejects.toThrow("over the 64000-byte cap");
    expect(await fs.stat(plan.writes[0]?.path ?? "").catch(() => undefined)).toBeUndefined();
  });

  test("a mint refuses a symlinked root, and an append refuses a symlinked or hard-linked file", async () => {
    const paths = await project();
    const elsewhere = path.join(paths.projectRoot, "elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.mkdir(path.join(paths.projectRoot, ".omp"), { recursive: true });
    await fs.symlink(elsewhere, path.join(paths.projectRoot, ".omp", "skills"));

    const mint = await planWrite(paths, lesson({ target: "retry-backoff" }));
    await expect(applyWrite(paths, mint)).rejects.toThrow("Refusing to write through the symlink");
    expect(await fs.readdir(elsewhere)).toEqual([]);

    const paths2 = await project();
    const real = path.join(paths2.projectRoot, ".omp", "real.md");
    await Bun.write(real, "outside\n");
    const linked = skillPath(paths2, "retry-helper");
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await fs.symlink(real, linked);
    await expect(applyWrite(paths2, await planWrite(paths2, lesson()))).rejects.toThrow("symlink");

    await fs.rm(linked);
    await fs.link(real, linked);
    await expect(applyWrite(paths2, await planWrite(paths2, lesson()))).rejects.toThrow("hard links");
  });
});
