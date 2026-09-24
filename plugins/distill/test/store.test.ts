import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
  encodeSessionDirName,
  isWithinProject,
  listProjectSessions,
  loadSession,
  resolveBranch,
  resolveStore,
  subagentSessionFiles,
} from "../src/store";
import {
  assistantMessage,
  customEntry,
  makeTempDir,
  textPart,
  titleSlot,
  userMessage,
  writeSessionFixture,
} from "./fixtures";

const identity = (target: string) => target;

describe("session directory naming", () => {
  test("home-relative, temp-relative and absolute paths each get their own shape", () => {
    const overrides = { home: "/Users/giardi", tmpDir: "/private/tmp", realpath: identity };

    expect(encodeSessionDirName("/Users/giardi", overrides)).toBe("-");
    expect(encodeSessionDirName("/Users/giardi/projects/omp-plugins", overrides)).toBe("-projects-omp-plugins");
    expect(encodeSessionDirName("/private/tmp", overrides)).toBe("-tmp");
    expect(encodeSessionDirName("/private/tmp/scratch", overrides)).toBe("-tmp-scratch");
    expect(encodeSessionDirName("/srv/app", overrides)).toBe("--srv-app--");
    expect(encodeSessionDirName("/Users/giardi/../giardi/x", overrides)).toBe("-x");
  });

  test("agrees with the host's own resolver", async () => {
    const agentDir = await makeTempDir("omp-distill-agent-");
    const project = await makeTempDir("omp-distill-project-");
    const repoRoot = path.resolve(import.meta.dir, "..");

    for (const cwd of [project, repoRoot, "/opt/elsewhere"]) {
      const hostDir = SessionManager.getDefaultSessionDir(cwd, agentDir);
      expect(encodeSessionDirName(cwd)).toBe(path.basename(hostDir));
    }
  });
});

describe("project session discovery", () => {
  test("selects the project's own sessions, skips foreign and unsupported ones", async () => {
    const root = await makeTempDir("omp-distill-home-");
    const home = path.join(root, "home");
    const agentDir = path.join(home, ".omp", "agent");
    const project = path.join(home, "work", "alpha");
    const other = path.join(home, "work", "beta");
    const overrides = { agentDir, home, tmpDir: "/private/tmp" };
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    const projectDir = resolveStore(project, overrides).projectDir;

    const foreign = await writeSessionFixture({
      dir: projectDir,
      sessionId: "aaaaaaaa-1111-7000-8000-000000000001",
      cwd: other,
      lines: [userMessage({ id: "1a2b3c4d", parentId: null }, "elsewhere")],
      fileTimestamp: "2026-09-23T15-00-00-000Z",
    });
    const ours = await writeSessionFixture({
      dir: projectDir,
      sessionId: "bbbbbbbb-1111-7000-8000-000000000002",
      cwd: project,
      lines: [userMessage({ id: "2a2b3c4d", parentId: null }, "here")],
      titleSlotTitle: "slot title",
      fileTimestamp: "2026-09-23T16-00-00-000Z",
    });
    const nested = await writeSessionFixture({
      dir: projectDir,
      sessionId: "cccccccc-1111-7000-8000-000000000003",
      cwd: path.join(project, "packages", "child"),
      lines: [userMessage({ id: "3a2b3c4d", parentId: null }, "in a subdirectory")],
      fileTimestamp: "2026-09-23T17-00-00-000Z",
    });
    const future = await writeSessionFixture({
      dir: projectDir,
      sessionId: "dddddddd-1111-7000-8000-000000000004",
      cwd: project,
      version: 99,
      lines: [],
      fileTimestamp: "2026-09-23T18-00-00-000Z",
    });
    await fs.writeFile(path.join(projectDir, "notes.txt"), "not a session\n");

    const at = (seconds: number) => new Date(Date.UTC(2026, 8, 23, 15, 0, seconds));
    await fs.utimes(foreign, at(1), at(1));
    await fs.utimes(ours, at(2), at(2));
    await fs.utimes(nested, at(3), at(3));
    await fs.utimes(future, at(4), at(4));

    const discovery = await listProjectSessions({ cwd: project, ...overrides, sessionDir: projectDir });

    expect(discovery.sessions.map(session => session.sessionId)).toEqual([
      "cccccccc-1111-7000-8000-000000000003",
      "bbbbbbbb-1111-7000-8000-000000000002",
    ]);
    expect(discovery.sessions[1]?.title).toBe("slot title");
    expect(discovery.sessions[1]?.path).toBe(ours);
    expect(discovery.sessions[0]?.path).toBe(nested);
    expect(discovery.skipped.map(skip => skip.path).sort()).toEqual([foreign, future].sort());
    expect(discovery.skipped.find(skip => skip.path === future)?.reason).toContain("newer than");

    const limited = await listProjectSessions({ cwd: project, ...overrides, sessionDir: projectDir, limit: 1 });
    expect(limited.sessions.map(session => session.path)).toEqual([nested]);
  });

  test("an absent project directory is an empty discovery, not an error", async () => {
    const home = await makeTempDir("omp-distill-home-");
    const discovery = await listProjectSessions({
      cwd: path.join(home, "never-used"),
      agentDir: path.join(home, ".omp", "agent"),
      home,
    });
    expect(discovery.sessions).toEqual([]);
    expect(discovery.skipped).toEqual([]);
  });

  test("a session started in a subdirectory is found through the running session's own directory", async () => {
    const home = await makeTempDir("omp-distill-home-");
    const agentDir = path.join(home, ".omp", "agent");
    const project = path.join(home, "work", "alpha");
    const subdirectory = path.join(project, "packages", "app");
    await fs.mkdir(subdirectory, { recursive: true });
    const overrides = { agentDir, home };

    // A session whose header names a subdirectory of the project, filed under that
    // subdirectory's own store directory — not the project root's.
    const subdirSessionDir = resolveStore(subdirectory, overrides).projectDir;
    await writeSessionFixture({
      dir: subdirSessionDir,
      sessionId: "99999999-1111-7000-8000-000000000009",
      cwd: subdirectory,
      lines: [userMessage({ id: "40000001", parentId: null }, "started deep")],
    });

    const viaSessionDir = await listProjectSessions({ cwd: project, ...overrides, sessionDir: subdirSessionDir });
    expect(viaSessionDir.sessions.map(session => session.sessionId)).toEqual([
      "99999999-1111-7000-8000-000000000009",
    ]);
    expect(viaSessionDir.dirs).toEqual([resolveStore(project, overrides).projectDir, subdirSessionDir]);
  });

  test("project containment", () => {
    expect(isWithinProject("/work/alpha", "/work/alpha")).toBe(true);
    expect(isWithinProject("/work/alpha", "/work/alpha/packages/app")).toBe(true);
    expect(isWithinProject("/work/alpha", "/work/alphabeta")).toBe(false);
    expect(isWithinProject("/work/alpha", "/work")).toBe(false);
  });
});

describe("branch resolution", () => {
  test("only the active branch of a forked session is traced", async () => {
    const dir = await makeTempDir("omp-distill-session-");
    const cwd = "/work/alpha";
    const total = (id: string, parentId: string | null, text: string) =>
      assistantMessage({ id, parentId }, [textPart(text)]);
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: "eeeeeeee-1111-7000-8000-000000000005",
      cwd,
      lines: [
        userMessage({ id: "10000001", parentId: null }, "start"),
        total("10000002", "10000001", "abandoned answer"),
        total("10000003", "10000002", "abandoned follow-up"),
        total("10000004", "10000001", "kept answer"),
        total("10000005", "10000004", "kept follow-up"),
      ],
    });

    const loaded = await loadSession(sessionPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.session.header.cwd).toBe(cwd);
    expect(resolveBranch(loaded.session.entries).map(entry => entry.id)).toEqual([
      "10000001",
      "10000004",
      "10000005",
    ]);
  });

  test("a parent cycle is survivable", () => {
    const cycle = [
      { type: "message", id: "a", parentId: "b", timestamp: "", message: {} },
      { type: "message", id: "b", parentId: "a", timestamp: "", message: {} },
    ];
    expect(resolveBranch(cycle as never).map(entry => entry.id)).toEqual(["a", "b"]);
  });
});

describe("session files and subagents", () => {
  test("the header is found behind the title slot, and subagents pair with their parent", async () => {
    const dir = await makeTempDir("omp-distill-store-");
    const cwd = "/work/alpha";
    const sessionPath = await writeSessionFixture({
      dir,
      sessionId: "ffffffff-1111-7000-8000-000000000006",
      cwd,
      lines: [
        userMessage({ id: "20000001", parentId: null }, "delegate"),
        customEntry({ id: "20000002", parentId: "20000001" }, "todo_hud_state", { items: [] }),
      ],
      subagents: [
        { name: "Worker", sessionId: "ffffffff-2222-7000-8000-000000000007", lines: [] },
        { name: "Worker/Worker.Child", sessionId: "ffffffff-3333-7000-8000-000000000008", lines: [] },
        { name: "__advisor", sessionId: "ffffffff-4444-7000-8000-000000000009", lines: [] },
      ],
    });

    const artifacts = sessionPath.slice(0, -".jsonl".length);
    expect(await subagentSessionFiles(sessionPath)).toEqual([
      path.join(artifacts, "Worker.jsonl"),
      path.join(artifacts, "Worker", "Worker.Child.jsonl"),
    ]);

    const loaded = await loadSession(sessionPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.session.header.id).toBe("ffffffff-1111-7000-8000-000000000006");
    expect(loaded.session.entries.map(entry => entry.type)).toEqual(["message", "custom"]);
  });

  test("a file with no session header is refused with a reason", async () => {
    const dir = await makeTempDir("omp-distill-store-");
    const scattered = path.join(dir, "scattered.jsonl");
    await fs.writeFile(scattered, `${titleSlot("orphan")}\n${JSON.stringify({ type: "custom", customType: "x" })}\n`);

    const loaded = await loadSession(scattered);
    expect(loaded).toEqual({ ok: false, reason: "no session header found" });
  });
});
