import type { Dirent } from "node:fs";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
  CURRENT_SESSION_VERSION,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { isRecord, messageOf } from "./util";

/**
 * The session store, read-only. omp's own transcript directory is the only source
 * (ADR-0006): one JSONL per session under a per-project directory derived from the
 * working directory, and a sibling directory holding one file per subagent.
 *
 * Nothing here writes. The per-project directory name is derived purely rather than
 * through the host's `computeDefaultSessionDir`, because that function creates the
 * directory and runs legacy-directory migrations.
 */

const JSONL_SUFFIX = ".jsonl";
const HEADER_PROBE_BYTES = 64 * 1024;

export interface StoreLocation {
  /** omp's session root: `<agentDir>/sessions`. */
  root: string;
  /** The directory holding this project's session files. */
  projectDir: string;
}

export interface StoreOverrides {
  agentDir?: string;
  home?: string;
  tmpDir?: string;
  /** Symlink resolution used before deciding a path's scope; injectable for tests. */
  realpath?: (target: string) => string;
}

/**
 * The per-project session directory name. Mirrors `getDefaultSessionDirName`
 * (`src/session/session-paths.ts` in the host): a path under home becomes
 * `-<relative>`, a path under the temp root `-tmp<relative>`, anything else
 * `--<absolute with separators replaced>--`.
 */
export function encodeSessionDirName(cwd: string, overrides: StoreOverrides = {}): string {
  const realpath =
    overrides.realpath ??
    ((target: string) => {
      try {
        return realpathSync.native(target);
      } catch {
        return path.resolve(target);
      }
    });
  const canonicalCwd = realpath(path.resolve(cwd));
  const canonicalHome = realpath(overrides.home ?? os.homedir());
  const canonicalTmp = realpath(overrides.tmpDir ?? os.tmpdir());

  const homeRelative = path.relative(canonicalHome, canonicalCwd);
  if (homeRelative === "" || isWithin(homeRelative)) return encodeRelative("-", homeRelative);

  const tmpRelative = path.relative(canonicalTmp, canonicalCwd);
  if (tmpRelative === "" || isWithin(tmpRelative)) return encodeRelative("-tmp", tmpRelative);

  return `--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function sessionsRoot(agentDir: string = getAgentDir()): string {
  return path.join(agentDir, "sessions");
}

export function resolveStore(cwd: string, overrides: StoreOverrides = {}): StoreLocation {
  const root = sessionsRoot(overrides.agentDir);
  return { root, projectDir: path.join(root, encodeSessionDirName(cwd, overrides)) };
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isWithinProject(projectRoot: string, child: string): boolean {
  return isWithin(path.relative(path.resolve(projectRoot), path.resolve(child)));
}

export interface SessionCandidate {
  path: string;
  sessionId: string;
  /** The working directory recorded in the session header. */
  cwd: string;
  title: string;
  created: string;
  modifiedMs: number;
}

export interface SkippedSession {
  path: string;
  reason: string;
}

export interface SessionDiscovery {
  /** The directories searched, in priority order. */
  dirs: string[];
  sessions: SessionCandidate[];
  skipped: SkippedSession[];
}

export interface ListSessionsOptions extends StoreOverrides {
  cwd: string;
  /**
   * The running session's own directory. A session started in a subdirectory of the project
   * lives in a different directory than one started at its root, so both are searched; the
   * header's recorded working directory decides what counts.
   */
  sessionDir?: string;
  /** How many of the most recently modified sessions to return. Default: all. */
  limit?: number;
}

/**
 * Select the project's own sessions: top-level `<timestamp>_<sessionId>.jsonl` files whose
 * header working directory lies inside the project. Unknown header versions and malformed
 * files are skipped with a reason rather than failing the scan.
 */
export async function listProjectSessions(options: ListSessionsOptions): Promise<SessionDiscovery> {
  const dirs = [resolveStore(options.cwd, options).projectDir];
  if (options.sessionDir !== undefined && !dirs.includes(options.sessionDir)) dirs.push(options.sessionDir);

  const skipped: SkippedSession[] = [];
  const sessions: SessionCandidate[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const name of names) {
      if (!name.endsWith(JSONL_SUFFIX)) continue;
      const filePath = path.join(dir, name);
      if (seen.has(filePath)) continue;
      seen.add(filePath);

      const stats = await fs.stat(filePath).catch(() => undefined);
      if (!stats?.isFile()) continue;

      const probe = await readSessionHeader(filePath);
      if ("reason" in probe) {
        skipped.push({ path: filePath, reason: probe.reason });
        continue;
      }
      if (!isWithinProject(options.cwd, probe.header.cwd)) {
        skipped.push({
          path: filePath,
          reason: `recorded working directory is outside this project: ${probe.header.cwd}`,
        });
        continue;
      }

      sessions.push({
        path: filePath,
        sessionId: probe.header.id,
        cwd: probe.header.cwd,
        title: probe.header.title ?? probe.titleSlotTitle ?? "",
        created: probe.header.timestamp,
        modifiedMs: stats.mtimeMs,
      });
    }
  }

  sessions.sort((left, right) => right.modifiedMs - left.modifiedMs);
  return {
    dirs,
    sessions: options.limit === undefined ? sessions : sessions.slice(0, Math.max(0, options.limit)),
    skipped,
  };
}

export interface LoadedSession {
  path: string;
  header: SessionHeader;
  /** Every record after the header, in file order. */
  entries: SessionEntry[];
}

export type SessionLoadResult = { ok: true; session: LoadedSession } | { ok: false; reason: string };

export async function loadSession(sessionPath: string): Promise<SessionLoadResult> {
  const probe = await readSessionHeader(sessionPath);
  if ("reason" in probe) return { ok: false, reason: probe.reason };

  let entries: FileEntry[];
  try {
    entries = await loadEntriesFromFile(sessionPath);
  } catch (error) {
    return { ok: false, reason: `unreadable session file: ${messageOf(error)}` };
  }

  return {
    ok: true,
    session: {
      path: sessionPath,
      header: probe.header,
      entries: entries.filter((entry): entry is SessionEntry => entry.type !== "session"),
    },
  };
}

/**
 * The active branch: records from the first record to the leaf. omp persists no leaf
 * marker, so the leaf is the last record in file order and the branch is the
 * `parentId` chain back to the root. A cycle (possible in a corrupt file) ends the walk.
 */
export function resolveBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);

  let cursor: SessionEntry | undefined = entries[entries.length - 1];
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  branch.reverse();
  return branch;
}

/**
 * The trace session ids one session file holds: its own, plus each subagent transcript's.
 * Retirement is measured per trace (ADR-0008), so eligibility cannot be decided from the
 * parent's id alone. Unreadable subagent files are left out; the evaluation reports them.
 */
export async function sessionTraceIds(sessionPath: string): Promise<string[]> {
  const probe = await readSessionHeader(sessionPath);
  const ids: string[] = [];
  if (!("reason" in probe)) ids.push(probe.header.id);

  for (const file of await subagentSessionFiles(sessionPath)) {
    const subagent = await readSessionHeader(file);
    if (!("reason" in subagent)) ids.push(subagent.header.id);
  }
  return ids;
}

/**
 * Subagent transcripts beside a session file: `<session>/<AgentId>.jsonl`, with
 * grandchildren one level deeper as `<session>/<AgentId>/<AgentId>.<ChildId>.jsonl`.
 * Advisor transcripts (`__advisor*.jsonl`) are excluded — observability output, not
 * the session's own work.
 */
export async function subagentSessionFiles(sessionPath: string): Promise<string[]> {
  const dir = sessionPath.endsWith(JSONL_SUFFIX) ? sessionPath.slice(0, -JSONL_SUFFIX.length) : sessionPath;
  const found = await collectJsonl(dir, 2);
  return found.filter(file => !path.basename(file).startsWith("__advisor")).sort();
}

interface HeaderProbe {
  header: SessionHeader;
  titleSlotTitle?: string;
}

/**
 * Scan a file's head for its session header. The `type:"session"` record is not
 * reliably first — a fixed-width `title` slot precedes it, and a title record can sit
 * between the two — so the header is searched for rather than assumed.
 */
async function readSessionHeader(filePath: string): Promise<HeaderProbe | { reason: string }> {
  let content: string;
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { reason: `unreadable session file: ${messageOf(error)}` };
  }

  let title: string | undefined;
  let header: SessionHeader | undefined;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A truncated final line in the probe window is expected; the full file is read on demand.
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") continue;
    if (parsed.type === "title" && typeof parsed.title === "string") {
      title = parsed.title;
      continue;
    }
    if (parsed.type !== "session") continue;
    if (typeof parsed.id !== "string" || typeof parsed.cwd !== "string") {
      return { reason: "session header is missing an id or a working directory" };
    }
    header = parsed as unknown as SessionHeader;
    break;
  }

  if (!header) return { reason: "no session header found" };

  const version = header.version ?? 1;
  if (version > CURRENT_SESSION_VERSION) {
    return { reason: `session header version ${version} is newer than this omp understands` };
  }
  return { header, titleSlotTitle: title };
}

async function collectJsonl(dir: string, depth: number): Promise<string[]> {
  if (depth <= 0) return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonl(target, depth - 1)));
    } else if (entry.isFile() && entry.name.endsWith(JSONL_SUFFIX)) {
      files.push(target);
    }
  }
  return files;
}

function encodeRelative(prefix: string, relative: string): string {
  const encoded = relative.replace(/[/\\:]/g, "-");
  if (encoded === "") return prefix;
  return prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}

function isWithin(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
