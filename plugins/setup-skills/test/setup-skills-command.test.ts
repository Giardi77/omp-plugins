import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
  getActiveSkills,
  resetActiveSkillsForTests,
  setActiveSkills,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import setupSkillsExtension, {
  filterDisabledSkillsFromSystemPrompt,
  hasRefreshSkills,
  isSessionWriteConflict,
  reloadSessionAfterIdle,
} from "../src/index";

const tempRoots: string[] = [];
const previousHomes: Array<string | undefined> = [];

type RegisteredCommand = {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type Notification = {
  message: string;
  type?: "info" | "warning" | "error";
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-setup-skills-command-"));
  tempRoots.push(root);
  return root;
}

async function makeTempProject(): Promise<string> {
  const root = await makeTempRoot();
  const fakeHome = path.join(root, "home");
  const project = path.join(root, "repo");

  previousHomes.push(process.env.HOME);
  process.env.HOME = fakeHome;

  await fs.mkdir(fakeHome, { recursive: true });
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.mkdir(path.join(project, ".omp", "skills", "alpha"), { recursive: true });
  await fs.mkdir(path.join(project, ".omp", "skills", "beta"), { recursive: true });
  await Bun.write(
    path.join(project, ".omp", "skills", "alpha", "SKILL.md"),
    "---\ndescription: Alpha project skill\n---\nUse alpha.\n",
  );
  await Bun.write(
    path.join(project, ".omp", "skills", "beta", "SKILL.md"),
    "---\ndescription: Beta project skill\n---\nUse beta.\n",
  );

  return project;
}

function isolatedSkillsConfig(): Record<string, unknown> {
  return {
    enableCodexUser: false,
    enableClaudeUser: false,
    enableClaudeProject: false,
    enablePiUser: false,
    enablePiProject: true,
    enableAgentsUser: false,
    enableAgentsProject: false,
  };
}

async function writeProjectConfig(project: string, config: Record<string, unknown>): Promise<string> {
  const configPath = path.join(project, ".omp", "config.yml");
  await Bun.write(configPath, YAML.stringify(config, null, 2));
  return configPath;
}

function registeredSetupSkillsCommand(): RegisteredCommand {
  const commands: Record<string, RegisteredCommand> = {};
  const labels: string[] = [];

  setupSkillsExtension({
    setLabel(label: string): void {
      labels.push(label);
    },
    registerCommand(name: string, options: RegisteredCommand): void {
      commands[name] = options;
    },
    on(): void {},
  } as unknown as ExtensionAPI);

  expect(labels).toEqual(["Setup Skills"]);
  const command = commands["setup-skills"];
  expect(command).toBeDefined();
  expect(command?.description).toBe("Select enabled skills for this project and reload the session");
  return command!;
}

type MockCommandContextOptions = {
  waitForIdle?: () => Promise<void>;
  reload?: () => Promise<void>;
  refreshSkills?: () => Promise<void>;
};

function mockCommandContext(
  cwd: string,
  selection: Set<string> | null,
  options: MockCommandContextOptions = {},
): {
  ctx: ExtensionCommandContext;
  notifications: Notification[];
  calls: {
    waitForIdle: number;
    custom: number;
    reload: number;
    refreshSkills: number;
  };
} {
  const notifications: Notification[] = [];
  const calls = {
    waitForIdle: 0,
    custom: 0,
    reload: 0,
    refreshSkills: 0,
  };

  const ctx = {
    hasUI: true,
    cwd,
    waitForIdle: async () => {
      calls.waitForIdle += 1;
      await options.waitForIdle?.();
    },
    reload: async () => {
      calls.reload += 1;
      await options.reload?.();
    },
    ...(options.refreshSkills
      ? {
          refreshSkills: async () => {
            calls.refreshSkills += 1;
            await options.refreshSkills?.();
          },
        }
      : {}),
    ui: {
      custom: async <T>() => {
        calls.custom += 1;
        return selection as T;
      },
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, notifications, calls };
}

afterEach(async () => {
  while (previousHomes.length > 0) {
    const previousHome = previousHomes.pop();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  resetActiveSkillsForTests();
});

describe("setup-skills command", () => {
  test("writes the confirmed project skill selection, waits for idle, and reloads the session", async () => {
    const project = await makeTempProject();
    const configPath = await writeProjectConfig(project, {
      model: "claude-sonnet",
      skills: isolatedSkillsConfig(),
    });
    const command = registeredSetupSkillsCommand();
    const { ctx, notifications, calls } = mockCommandContext(project, new Set(["alpha"]));

    await command.handler("", ctx);

    expect(calls).toEqual({ waitForIdle: 1, custom: 1, reload: 1, refreshSkills: 0 });
    const written = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
    const writtenSkills = written.skills as Record<string, unknown>;
    expect(written.model).toBe("claude-sonnet");
    for (const [key, value] of Object.entries(isolatedSkillsConfig())) {
      expect(writtenSkills[key]).toBe(value);
    }
    expect(writtenSkills.enabled).toBe(true);
    expect(writtenSkills.includeSkills).toEqual([]);
    expect(Array.isArray(writtenSkills.ignoredSkills)).toBe(true);
    const ignoredSkills = writtenSkills.ignoredSkills as string[];
    expect(ignoredSkills).toContain("beta");
    expect(ignoredSkills).not.toContain("alpha");
    expect(notifications).toEqual([
      {
        message: `Updated ${configPath} (1 enabled, ${ignoredSkills.length} disabled). Reloading skills when the agent is idle...`,
        type: "info",
      },
    ]);
  });

  test("writes the config before waiting for an active turn to finish and reloads only after idle", async () => {
    const project = await makeTempProject();
    const configPath = await writeProjectConfig(project, {
      model: "claude-sonnet",
      skills: isolatedSkillsConfig(),
    });
    const command = registeredSetupSkillsCommand();
    const idle = deferred<void>();
    let markWaitStarted!: () => void;
    const waitStarted = new Promise<void>(resolve => {
      markWaitStarted = resolve;
    });
    const { ctx, calls } = mockCommandContext(project, new Set(["alpha"]), {
      waitForIdle: async () => {
        markWaitStarted();
        await idle.promise;
      },
    });
    const run = command.handler("", ctx);

    await waitStarted;

    let assertionError: unknown;
    try {
      expect(calls.custom).toBe(1);
      expect(calls.reload).toBe(0);
      const written = YAML.parse(await Bun.file(configPath).text()) as Record<string, unknown>;
      const writtenSkills = written.skills as Record<string, unknown>;
      expect(writtenSkills.enabled).toBe(true);
      expect(writtenSkills.includeSkills).toEqual([]);
      expect(writtenSkills.ignoredSkills).toContain("beta");
      expect(writtenSkills.ignoredSkills).not.toContain("alpha");
    } catch (error) {
      assertionError = error;
    } finally {
      idle.resolve();
      await run;
    }

    if (assertionError !== undefined) {
      throw assertionError;
    }
    expect(calls).toEqual({ waitForIdle: 1, custom: 1, reload: 1, refreshSkills: 0 });
  });

  test("removes unchecked skills from the active agent skill registry", async () => {
    const project = await makeTempProject();
    await writeProjectConfig(project, {
      skills: isolatedSkillsConfig(),
    });
    setActiveSkills([
      {
        name: "alpha",
        description: "Alpha project skill",
        filePath: path.join(project, ".omp", "skills", "alpha", "SKILL.md"),
        baseDir: path.join(project, ".omp", "skills", "alpha"),
        source: "native:project",
      },
      {
        name: "beta",
        description: "Beta project skill",
        filePath: path.join(project, ".omp", "skills", "beta", "SKILL.md"),
        baseDir: path.join(project, ".omp", "skills", "beta"),
        source: "native:project",
      },
    ]);
    const command = registeredSetupSkillsCommand();
    const { ctx } = mockCommandContext(project, new Set(["alpha"]));

    await command.handler("", ctx);

    expect(getActiveSkills().map(skill => skill.name)).toEqual(["alpha"]);
  });

  test("removes unchecked skills from stale standard and custom system prompts", () => {
    const prompt = [
      "Skills\n<skills>\n- alpha: Alpha project skill\n- beta: Beta project skill\n</skills>\nRules",
      '<skills>\n<skill name="alpha">\nAlpha project skill\n</skill>\n<skill name="beta">\nBeta project skill\n</skill>\n</skills>',
    ];

    expect(filterDisabledSkillsFromSystemPrompt(prompt, new Set(["beta"]))).toEqual([
      "Skills\n<skills>\n- alpha: Alpha project skill\n</skills>\nRules",
      '<skills>\n<skill name="alpha">\nAlpha project skill\n</skill>\n</skills>',
    ]);
  });

  test("retries session reload after an OMP write-conflict, then warns if it keeps racing", async () => {
    const project = await makeTempProject();
    await writeProjectConfig(project, {
      skills: isolatedSkillsConfig(),
    });
    const command = registeredSetupSkillsCommand();
    const conflict = new Error(
      "Session file changed before rewrite: session.jsonl (expected 739218 bytes, found 740341 bytes).",
    );
    let reloadAttempts = 0;
    const { ctx, notifications, calls } = mockCommandContext(project, new Set(["alpha"]), {
      reload: async () => {
        reloadAttempts += 1;
        throw conflict;
      },
    });

    await command.handler("", ctx);

    expect(isSessionWriteConflict(conflict)).toBe(true);
    expect(reloadAttempts).toBe(3);
    expect(calls).toEqual({ waitForIdle: 3, custom: 1, reload: 3, refreshSkills: 0 });
    expect(notifications.at(-1)).toEqual({
      message:
        "Skills config saved, but OMP could not rewrite the session file. Restart OMP to apply skill commands. Session file changed before rewrite: session.jsonl (expected 739218 bytes, found 740341 bytes).",
      type: "warning",
    });
  });

  test("reloadSessionAfterIdle succeeds after a single write-conflict", async () => {
    let reloads = 0;
    await reloadSessionAfterIdle({
      waitForIdle: async () => {},
      reload: async () => {
        reloads += 1;
        if (reloads === 1) {
          throw new Error("SessionWriteConflictError: Session file changed before rewrite");
        }
      },
    });
    expect(reloads).toBe(2);
  });

  test("prefers ctx.refreshSkills when present and does not rediscover or reload the session", async () => {
    const project = await makeTempProject();
    await writeProjectConfig(project, {
      skills: isolatedSkillsConfig(),
    });
    setActiveSkills([
      {
        name: "alpha",
        description: "Alpha project skill",
        filePath: path.join(project, ".omp", "skills", "alpha", "SKILL.md"),
        baseDir: path.join(project, ".omp", "skills", "alpha"),
        source: "native:project",
      },
      {
        name: "beta",
        description: "Beta project skill",
        filePath: path.join(project, ".omp", "skills", "beta", "SKILL.md"),
        baseDir: path.join(project, ".omp", "skills", "beta"),
        source: "native:project",
      },
    ]);
    const command = registeredSetupSkillsCommand();
    const { ctx, calls } = mockCommandContext(project, new Set(["alpha"]), {
      refreshSkills: async () => {},
    });

    expect(hasRefreshSkills(ctx)).toBe(true);
    await command.handler("", ctx);

    expect(calls).toEqual({ waitForIdle: 1, custom: 1, reload: 0, refreshSkills: 1 });
    expect(getActiveSkills().map(skill => skill.name)).toEqual(["alpha", "beta"]);
  });

  test("leaves project config and session reload untouched when skill selection is cancelled", async () => {
    const project = await makeTempProject();
    const configPath = path.join(project, ".omp", "config.yml");
    const originalConfig = YAML.stringify(
      {
        model: "claude-sonnet",
        skills: isolatedSkillsConfig(),
      },
      null,
      2,
    );
    await Bun.write(configPath, originalConfig);
    const command = registeredSetupSkillsCommand();
    const { ctx, notifications, calls } = mockCommandContext(project, null);

    await command.handler("", ctx);

    expect(calls).toEqual({ waitForIdle: 0, custom: 1, reload: 0, refreshSkills: 0 });
    expect(notifications).toEqual([{ message: "Project skills unchanged.", type: "info" }]);
    expect(await Bun.file(configPath).text()).toBe(originalConfig);
  });
});
