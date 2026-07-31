import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";

/**
 * Plugin state lives in two places, by secrecy:
 * - Project config `.omp/config.yml` (`telegram:` section): non-secret state only (chatId,
 *   later the topic↔session map). Users may commit this file — setup-skills selections are
 *   shareable, so nothing secret may ever land here.
 * - User-global `~/.omp/telegram.json` (mode 0600) or env OMP_TELEGRAM_BOT_TOKEN: the bot token.
 *
 * The YAML round-trip helpers intentionally mirror plugins/setup-skills/src/project-skills.ts.
 * If a third plugin needs them, extract a shared package instead of forking a third copy.
 */

export interface TelegramProjectConfig {
  chatId?: number;
}

export interface TelegramPluginState {
  projectRoot: string;
  configPath: string;
  chatId?: number;
  botToken?: string;
}

const PROJECT_CONFIG_SECTION = "telegram";

type RawConfig = Record<string, unknown>;

/** The package's single canonical object guard; do not recreate guards at call sites. */
export function isRecord(value: unknown): value is RawConfig {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function existsAsDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from cwd to the directory holding `.omp/` (mirrors setup-skills' root resolution). */
export async function resolveProjectRoot(cwd: string): Promise<string> {
  const start = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  let dir = start;
  while (true) {
    if (dir !== home && (await existsAsDirectory(path.join(dir, ".omp")))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break;
    dir = parent;
  }
  return start;
}

async function readProjectConfig(configPath: string): Promise<RawConfig> {
  let content: string;
  try {
    content = await Bun.file(configPath).text();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${configPath}: ${message}`);
  }

  if (parsed === undefined || parsed === null) return {};
  if (!isRecord(parsed)) throw new Error(`${configPath} must contain a YAML object`);
  return parsed;
}

export function readTelegramSection(config: RawConfig): TelegramProjectConfig {
  const section = config[PROJECT_CONFIG_SECTION];
  if (!isRecord(section)) return {};
  const chatId = section.chatId;
  return typeof chatId === "number" ? { chatId } : {};
}

const GLOBAL_TOKEN_PATH = path.join(os.homedir(), ".omp", "telegram.json");

export async function loadBotToken(): Promise<string | undefined> {
  if (process.env.OMP_TELEGRAM_BOT_TOKEN) return process.env.OMP_TELEGRAM_BOT_TOKEN;
  try {
    const parsed: unknown = JSON.parse(await Bun.file(GLOBAL_TOKEN_PATH).text());
    if (isRecord(parsed) && typeof parsed.botToken === "string") return parsed.botToken;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function saveBotToken(token: string): Promise<void> {
  const filePath = GLOBAL_TOKEN_PATH;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ botToken: token }, null, 2), { mode: 0o600 });
}

function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".omp", "config.yml");
}

export async function loadPluginState(cwd: string): Promise<TelegramPluginState> {
  const projectRoot = await resolveProjectRoot(cwd);
  const configPath = projectConfigPath(projectRoot);
  const config = await readProjectConfig(configPath);
  const section = readTelegramSection(config);
  const botToken = await loadBotToken();
  return {
    projectRoot,
    configPath,
    ...(section.chatId !== undefined ? { chatId: section.chatId } : {}),
    ...(botToken ? { botToken } : {}),
  };
}

export async function savePairedChat(projectRoot: string, chatId: number): Promise<void> {
  const configPath = projectConfigPath(projectRoot);
  const config = await readProjectConfig(configPath);
  const existing = isRecord(config[PROJECT_CONFIG_SECTION]) ? config[PROJECT_CONFIG_SECTION] : {};
  config[PROJECT_CONFIG_SECTION] = { ...existing, chatId };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await Bun.write(configPath, YAML.stringify(config));
}

/** Persisted topic↔session map (thread ids are stable per chat). Non-secret, lives in project config. */
export async function loadTopics(projectRoot: string): Promise<Record<string, number>> {
  const config = await readProjectConfig(projectConfigPath(projectRoot));
  const section = config[PROJECT_CONFIG_SECTION];
  if (!isRecord(section) || !isRecord(section.topics)) return {};
  const topics: Record<string, number> = {};
  for (const [sessionId, threadId] of Object.entries(section.topics)) {
    if (typeof threadId === "number") topics[sessionId] = threadId;
  }
  return topics;
}

export async function saveTopics(projectRoot: string, topics: Record<string, number>): Promise<void> {
  const configPath = projectConfigPath(projectRoot);
  const config = await readProjectConfig(configPath);
  const existing = isRecord(config[PROJECT_CONFIG_SECTION]) ? config[PROJECT_CONFIG_SECTION] : {};
  config[PROJECT_CONFIG_SECTION] = { ...existing, topics };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await Bun.write(configPath, YAML.stringify(config));
}
