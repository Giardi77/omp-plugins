import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import {
  DEFAULT_CONFIG,
  distillPaths,
  isActive,
  readConfig,
  readEvaluatorTemplate,
  setEnabled,
  setupProject,
} from "../src/config";
import { makeTempDir } from "./fixtures";

async function tempProject(): Promise<string> {
  const root = await makeTempDir("omp-distill-config-");
  return path.join(root, "project");
}

describe("activation and config", () => {
  test("a project is active only once the config file exists", async () => {
    const project = await tempProject();
    const paths = distillPaths(project);

    expect(await isActive(paths)).toBe(false);
    expect(await readConfig(paths)).toBeUndefined();

    const setup = await setupProject(project);
    expect(setup.evaluatorCreated).toBe(true);
    expect(setup.config).toEqual(DEFAULT_CONFIG);
    expect(await isActive(paths)).toBe(true);

    const config = await readConfig(paths);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config?.timeout_seconds).toBe(600);
  });

  test("the project gets the shipped evaluator prompt, verbatim", async () => {
    const project = await tempProject();
    const paths = distillPaths(project);
    await setupProject(project);

    // The default prompt is a Markdown file in the plugin, not a string in the source.
    const template = await Bun.file(path.join(import.meta.dir, "..", "templates", "evaluator.md")).text();
    expect(await Bun.file(paths.evaluatorPath).text()).toBe(template);
    expect(await readEvaluatorTemplate()).toBe(template);
    expect(template).toContain("# What this project learns from its sessions");
    expect(template).toContain("## The bar");
    expect(template).toContain("## What you see");
    // Taste alone: the mechanics live in the propose_lessons description (D15).
    expect(template).not.toContain("propose_lessons");
  });

  test("setup writes the ignore rule and the store directories", async () => {
    const project = await tempProject();
    const paths = distillPaths(project);
    await setupProject(project);

    expect(await Bun.file(paths.gitignorePath).text()).toBe("tmp/\n.locks/\n");
    for (const dir of [paths.lessonsDir, paths.tmpDir]) {
      expect((await fs.stat(dir)).isDirectory()).toBe(true);
    }
    const config = YAML.parse(await Bun.file(paths.configPath).text()) as Record<string, unknown>;
    expect(config.enabled).toBe(true);
    expect(config.include_thinking).toBe(false);
  });

  test("setup never clobbers an edited evaluator prompt or unknown keys", async () => {
    const project = await tempProject();
    const paths = distillPaths(project);
    await setupProject(project);
    await Bun.write(paths.evaluatorPath, "# mine\n");
    await Bun.write(paths.configPath, YAML.stringify({ enabled: true, project_key: "keep me" }, null, 2));

    const setup = await setupProject(project, { model: "anthropic/claude-sonnet" });
    expect(setup.evaluatorCreated).toBe(false);
    expect(await Bun.file(paths.evaluatorPath).text()).toBe("# mine\n");

    const raw = YAML.parse(await Bun.file(paths.configPath).text()) as Record<string, unknown>;
    expect(raw.project_key).toBe("keep me");
    expect(raw.model).toBe("anthropic/claude-sonnet");
    expect((await readConfig(paths))?.model).toBe("anthropic/claude-sonnet");
  });

  test("enable and disable toggle the same file", async () => {
    const project = await tempProject();
    const paths = distillPaths(project);
    await setupProject(project);

    const disabled = await setEnabled(paths, false);
    expect(disabled.enabled).toBe(false);
    expect((await readConfig(paths))?.enabled).toBe(false);

    const enabled = await setEnabled(paths, true);
    expect(enabled.enabled).toBe(true);
    expect((await readConfig(paths))?.enabled).toBe(true);

    await fs.rm(paths.configPath);
    await expect(setEnabled(paths, true)).rejects.toThrow("run /distill setup first");
  });

  test("malformed values fall back to defaults rather than failing the loop", async () => {
    const project = await tempProject();
    const paths = distillPaths(project);
    await setupProject(project);
    await Bun.write(
      paths.configPath,
      YAML.stringify({ enabled: "yes", timeout_seconds: -5, scan_limit: "lots", include_thinking: "true" }, null, 2),
    );

    const config = await readConfig(paths);
    expect(config?.enabled).toBe(false);
    expect(config?.timeout_seconds).toBe(600);
    expect(config?.scan_limit).toBe(5);
    expect(config?.include_thinking).toBe(false);
  });
});
