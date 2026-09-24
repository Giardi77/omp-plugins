import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { distillPaths, setupProject, type DistillPaths } from "../src/config";
import type { StoredLesson } from "../src/lessons";
import { agentInventory, applyWrite, planWrite, readInventory, skillInventory } from "../src/writer";
import { makeTempDir } from "./fixtures";

function lesson(overrides: Partial<StoredLesson> = {}): StoredLesson {
  return {
    id: "abcdef123456",
    state: "approved",
    kind: "patch_skill",
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

async function writeSkill(paths: DistillPaths, name: string, content: string): Promise<string> {
  const filePath = path.join(paths.projectRoot, ".omp", "skills", name, "SKILL.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
  return filePath;
}

describe("write plans", () => {
  test("a patch appends a dated section and names the target", async () => {
    const paths = await project();
    const filePath = await writeSkill(paths, "retry-helper", "---\nname: retry-helper\ndescription: Retries\n---\n\nHand-written prose.\n");

    const plan = await planWrite(paths, lesson(), new Date("2026-09-24T12:00:00.000Z"));

    expect(plan.mode).toBe("patch_skill");
    expect(plan.target).toBe("retry-helper");
    expect(plan.filePath).toBe(filePath);
    expect(plan.text).toContain("## Lesson — 2026-09-24");
    expect(plan.text).toContain("Sleep at least 250ms between retry attempts.");
    expect(plan.text).toContain(".omp/distill/lessons/abcdef123456.json");
  });

  test("a patch refuses a target that does not exist, and a name outside the allowlist", async () => {
    const paths = await project();
    await expect(planWrite(paths, lesson())).rejects.toThrow("propose a new_skill instead");
    await expect(planWrite(paths, lesson({ target: "../escape" }))).rejects.toThrow("Invalid skill name");
    await expect(planWrite(paths, lesson({ target: "under_score" }))).rejects.toThrow("Invalid skill name");
  });

  test("a minted skill carries a frontmatter description, or is refused", async () => {
    const paths = await project();
    const mint = lesson({ kind: "new_skill", target: "retry-backoff", title: "Retry backoff is coarse" });

    const plan = await planWrite(paths, mint);
    expect(plan.mode).toBe("new_skill");
    expect(plan.text.startsWith("---\nname: retry-backoff\ndescription: Retry backoff is coarse\n---\n")).toBe(true);
    expect(plan.text).toContain("Sleep at least 250ms between retry attempts.");

    const silentDrop = lesson({ kind: "new_skill", target: "retry-backoff", title: "<><>" });
    await expect(planWrite(paths, silentDrop)).rejects.toThrow("drops a SKILL.md without one");
  });

  test("minting refuses to overwrite an existing skill", async () => {
    const paths = await project();
    await writeSkill(paths, "retry-backoff", "---\ndescription: Existing\n---\n");
    await expect(planWrite(paths, lesson({ kind: "new_skill", target: "retry-backoff" }))).rejects.toThrow(
      "already exists",
    );
  });

  test("an agent prompt is patched, never created", async () => {
    const paths = await project();
    await expect(planWrite(paths, lesson({ kind: "agent_prompt", target: "reviewer" }))).rejects.toThrow(
      "only patches existing ones",
    );

    const agentPath = path.join(paths.projectRoot, ".omp", "agents", "reviewer.md");
    await fs.mkdir(path.dirname(agentPath), { recursive: true });
    await Bun.write(agentPath, "# Reviewer\n\nBe terse.\n");

    const plan = await planWrite(paths, lesson({ kind: "agent_prompt", target: "reviewer" }));
    expect(plan.mode).toBe("patch_agent");
    expect(plan.filePath).toBe(agentPath);
    expect(plan.text).toContain("## Lesson —");

    await expect(planWrite(paths, lesson({ kind: "agent_prompt", target: "REVIEWER!" }))).rejects.toThrow(
      "not a usable agent name",
    );
  });

  test("the inventory reports skills and agent prompts for the overlap check", async () => {
    const paths = await project();
    await writeSkill(paths, "retry-helper", "---\nname: retry-helper\ndescription: Retry advice\n---\n");
    await Bun.write(path.join(paths.projectRoot, ".omp", "agents", "reviewer.md"), "# Reviewer\n");

    expect(await skillInventory(paths)).toEqual([
      { name: "retry-helper", description: "Retry advice", filePath: path.join(paths.projectRoot, ".omp", "skills", "retry-helper", "SKILL.md") },
    ]);
    expect(await agentInventory(paths)).toEqual(["reviewer"]);
    expect(await readInventory(paths)).toMatchObject({ agents: ["reviewer"] });
  });
});

describe("applying a write", () => {
  test("a patch appends after the hand-written prose and leaves it intact", async () => {
    const paths = await project();
    const original = "---\nname: retry-helper\ndescription: Retries\n---\n\nHand-written prose.\n";
    const filePath = await writeSkill(paths, "retry-helper", original);
    const plan = await planWrite(paths, lesson());

    const result = await applyWrite(paths, plan);

    const content = await Bun.file(filePath).text();
    expect(content.startsWith(original)).toBe(true);
    expect(content).toContain("Hand-written prose.\n\n## Lesson —");
    expect(result.path).toBe(filePath);
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
  });

  test("a mint creates the skill once", async () => {
    const paths = await project();
    const plan = await planWrite(paths, lesson({ kind: "new_skill", target: "retry-backoff" }));
    const result = await applyWrite(paths, plan);

    expect(result.path).toBe(path.join(paths.projectRoot, ".omp", "skills", "retry-backoff", "SKILL.md"));
    expect(await Bun.file(result.path).text()).toBe(plan.text);
    await expect(applyWrite(paths, plan)).rejects.toThrow();
  });

  test("the size cap is enforced on the final file, before anything is written", async () => {
    const paths = await project();
    const padding = "x".repeat(63_000);
    const filePath = await writeSkill(paths, "retry-helper", `---\nname: retry-helper\ndescription: Retries\n---\n\n${padding}\n`);

    const plan = await planWrite(paths, lesson({ body: "y".repeat(2_000) }));
    await expect(applyWrite(paths, plan)).rejects.toThrow("over the 64000-byte cap");
    expect((await Bun.file(filePath).text()).endsWith(`${padding}\n`)).toBe(true);
  });

  test("a symlinked or hard-linked skill file is refused", async () => {
    const paths = await project();
    await writeSkill(paths, "retry-helper", "---\nname: retry-helper\ndescription: Retries\n---\n");

    const real = path.join(paths.projectRoot, ".omp", "skills", "real.md");
    await Bun.write(real, "outside\n");
    const linked = path.join(paths.projectRoot, ".omp", "skills", "retry-helper", "SKILL.md");
    await fs.rm(linked);
    await fs.symlink(real, linked);
    await expect(applyWrite(paths, await planWrite(paths, lesson()))).rejects.toThrow("symlink");

    await fs.rm(linked);
    await fs.link(real, linked);
    await expect(applyWrite(paths, await planWrite(paths, lesson()))).rejects.toThrow("hard links");
  });
});
