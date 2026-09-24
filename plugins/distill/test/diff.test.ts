import { describe, expect, test } from "bun:test";
import { distillPaths } from "../src/config";
import { describeChange, planFileChanges, renderFileChange } from "../src/diff";
import { makeTempDir } from "./fixtures";

const theme = {
  added: (text: string) => `A${text}`,
  removed: (text: string) => `R${text}`,
  context: (text: string) => `C${text}`,
  meta: (text: string) => `M${text}`,
};

async function project(): Promise<{ root: string; paths: ReturnType<typeof distillPaths> }> {
  const root = await makeTempDir("omp-distill-diff-");
  const paths = distillPaths(root);
  return { root, paths };
}

describe("planning a change", () => {
  test("a create is added lines numbered from one, with nothing to compare against", async () => {
    const { paths } = await project();
    const changes = await planFileChanges(paths, [
      { path: ".omp/rules/tests.md", mode: "create", text: "---\nname: tests\n\nRun from packages/core.\n" },
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.added).toBe(4);
    expect(changes[0]?.context).toBe(0);
    expect(changes[0]?.lines.map(line => line.number)).toEqual([1, 2, 3, 4]);
    expect(changes[0]?.lines.every(line => line.kind === "added")).toBe(true);
    // The trailing newline is a terminator, not a fifth empty line.
    expect(changes[0]?.lines[3]?.text).toBe("Run from packages/core.");
  });

  test("an append carries the file's own tail as context and continues its numbering", async () => {
    const { root, paths } = await project();
    const target = `${root}/.omp/skills/sql-migrations/SKILL.md`;
    await Bun.write(target, ["---", "name: sql-migrations", "# Migration rules", "Migrations are applied by hand.", "Keep them small.", ""].join("\n"));

    const changes = await planFileChanges(paths, [
      { path: ".omp/skills/sql-migrations/SKILL.md", mode: "append", text: "\n## Applied migrations\n\nAppend-only.\n" },
    ]);

    const change = changes[0];
    expect(change?.mode).toBe("append");
    expect(change?.path).toBe(".omp/skills/sql-migrations/SKILL.md");
    // The last three existing lines, with their real numbers.
    expect(change?.lines.filter(line => line.kind === "context").map(line => [line.number, line.text])).toEqual([
      [3, "# Migration rules"],
      [4, "Migrations are applied by hand."],
      [5, "Keep them small."],
    ]);
    // The added block starts after them, and the leading blank line of the section counts.
    expect(change?.lines.filter(line => line.kind === "added").map(line => [line.number, line.text])).toEqual([
      [6, ""],
      [7, "## Applied migrations"],
      [8, ""],
      [9, "Append-only."],
    ]);
  });

  test("a file that is not there yet reads as an empty append, never as an error", async () => {
    const { paths } = await project();
    const changes = await planFileChanges(paths, [{ path: ".omp/APPEND_SYSTEM.md", mode: "append", text: "Be brief.\n" }]);
    expect(changes[0]?.context).toBe(0);
    expect(changes[0]?.added).toBe(1);
  });
});

describe("rendering a change", () => {
  const change = {
    path: ".omp/rules/tests.md",
    mode: "create" as const,
    added: 3,
    removed: 0,
    context: 0,
    lines: [
      { kind: "added" as const, number: 1, text: "---" },
      { kind: "added" as const, number: 2, text: "name: tests" },
      { kind: "added" as const, number: 3, text: "a line that is going to be cut because it is far too long for this pane" },
    ],
  };

  test("says what it does to which file, and marks the added lines", () => {
    expect(describeChange(change)).toBe("new file  .omp/rules/tests.md  (+3)");
    expect(describeChange({ ...change, mode: "append", context: 4 })).toBe("append  .omp/rules/tests.md  (+3, 4 context)");

    const lines = renderFileChange(change, theme, 40);
    expect(lines[0]).toBe("Mnew file  .omp/rules/tests.md  (+3)");
    expect(lines[1]).toBe("A1 + ---");
    expect(lines[2]).toBe("A2 + name: tests");
    // The long third line wraps under its own text rather than being clipped: it is the lesson, and
    // the operator is approving exactly what it says.
    expect(lines[3]).toBe("A3 + a line that is going to be cut");
    // The tail of that long line sits on the next row, indented past the number and gutter.
    expect(lines[4]?.startsWith("A    ")).toBe(true);
    expect(lines[4]).toContain("because it is far too long");
    for (const line of lines) expect(line.replace(/^[ACM]/, "").length).toBeLessThanOrEqual(40);
  });

  test("a trim shows the lines going out and the ones taking their place", async () => {
    const { root, paths } = await project();
    const target = `${root}/.omp/skills/retry-helper/SKILL.md`;
    await Bun.write(target, ["# Retries", "", "Sleep 100ms between attempts.", "", "## Old note", "", "Ignore this.", ""].join("\n"));

    const changes = await planFileChanges(paths, [
      {
        path: ".omp/skills/retry-helper/SKILL.md",
        mode: "splice",
        remove: "## Old note\n\nIgnore this.",
        text: "Sleep 250ms; 100ms flaps under CI load.\n",
      },
    ]);

    const change = changes[0];
    expect(change?.removed).toBe(3);
    expect(change?.added).toBe(1);
    expect(describeChange(change!)).toBe("trim  .omp/skills/retry-helper/SKILL.md  (+1, -3, 3 context)");
    const rows = change?.lines.map(line => `${line.kind}:${line.text}`) ?? [];
    expect(rows).toContain("context:Sleep 100ms between attempts.");
    expect(rows).toContain("removed:## Old note");
    expect(rows).toContain("removed:Ignore this.");
    expect(rows).toContain("added:Sleep 250ms; 100ms flaps under CI load.");

    const rendered = renderFileChange(change!, theme, 80);
    expect(rendered.some(line => line.startsWith("R"))).toBe(true);
    expect(rendered.some(line => line.startsWith("A"))).toBe(true);
  });

  test("a change longer than the pane is capped, and says how much it cut", () => {
    const long = {
      ...change,
      added: 10,
      removed: 0,
      lines: Array.from({ length: 10 }, (_unused, index) => ({ kind: "added" as const, number: index + 1, text: `line ${index + 1}` })),
    };
    const capped = renderFileChange(long, theme, 80, { maxLines: 4 });
    expect(capped).toHaveLength(1 + 4 + 1);
    expect(capped[4]).toBe("A4 + line 4");
    expect(capped[5]).toBe("M… 6 more line(s)");

    // The changeset view asks for everything, and gets it.
    expect(renderFileChange(long, theme, 80)).toHaveLength(11);
  });

  test("context lines are shown as they are, dim rather than marked", () => {
    const appended = {
      ...change,
      mode: "append" as const,
      added: 1,
      removed: 0,
      context: 2,
      lines: [
        { kind: "context" as const, number: 9, text: "## Hands-on rules" },
        { kind: "context" as const, number: 10, text: "" },
        { kind: "added" as const, number: 11, text: "Run the suite from packages/core." },
      ],
    };
    const lines = renderFileChange(appended, theme, 80);
    expect(lines[1]).toBe("C 9   ## Hands-on rules");
    expect(lines[3]).toBe("A11 + Run the suite from packages/core.");
  });
});
