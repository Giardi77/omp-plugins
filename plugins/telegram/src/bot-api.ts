/**
 * Minimal typed client for the Telegram Bot API — zero dependencies, plain HTTPS via fetch.
 * Only the methods the OMP Telegram bridge needs. Keep shapes aligned with
 * https://core.telegram.org/bots/api (changelog-verified 2026-07, Bot API 10.2).
 */

export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** Rich messages (sendRichMessage/sendRichMessageDraft) allow up to 32k chars and 500 blocks. */
export const RICH_MESSAGE_LIMIT = 32768;
/** Draft updates share the chat-action rate bucket (~20 calls / 5s per peer). */
export const DRAFT_MIN_INTERVAL_MS = 300;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  /** getMe only: true when the bot has Threaded Mode (forum topics) enabled in private chats. */
  has_topics_enabled?: boolean;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  message_thread_id?: number;
  is_topic_message?: boolean;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramForumTopic {
  message_thread_id: number;
  name: string;
  icon_color?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineKeyboardButton[][];

/** Rich formatted text (Bot API 10.1+): plain string, entity node, or a mixed array. */
export type RichText = string | RichTextNode | Array<RichTextNode>;
export type RichTextNode = string | ({ type: string } & Record<string, unknown>);

/**
 * Block tree for InputRichMessage.blocks. Scalar shapes verified against the Bot API
 * reference; prefer composing via `html`/`markdown` — blocks are the escape hatch.
 */
export type InputRichBlock =
  | { type: "paragraph"; text: RichText }
  | { type: "heading"; text: RichText; size?: number }
  | { type: "pre"; text: RichText; language?: string }
  | { type: "footer"; text: RichText }
  | { type: "divider" }
  | { type: "thinking"; text: RichText }
  | ({ type: string } & Record<string, unknown>);

export interface InputRichMessageMedia {
  id: string;
  media: Record<string, unknown>;
}

/** Exactly one of html, markdown, or blocks must be set. */
export interface InputRichMessage {
  html?: string;
  markdown?: string;
  blocks?: InputRichBlock[];
  media?: InputRichMessageMedia[];
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

export class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram API error ${status}: ${description}`);
    this.name = "TelegramApiError";
  }
  /** 409 Conflict: another consumer is already polling this bot token. Never retry blindly. */
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Every Bot API call aborts after this; a stalled fetch must never wedge the bridge silently. */
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
/** Long polls get their requested timeout plus this grace window before the abort fires. */
const GET_UPDATES_GRACE_MS = 10_000;

export class TelegramBotApi {
  constructor(
    readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!payload.ok) {
      throw new TelegramApiError(response.status, payload.description ?? "unknown error");
    }
    return payload.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call("getMe");
  }

  getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      },
      timeoutSeconds * 1000 + GET_UPDATES_GRACE_MS,
    );
  }

  sendMessage(
    chatId: number,
    text: string,
    options: { threadId?: number; keyboard?: InlineKeyboard; parseMode?: "HTML" | "MarkdownV2" } = {},
  ): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
      ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
    });
  }

  /** Stream an ephemeral ~30s draft preview; finalize with sendMessage/sendRichMessage. */
  sendMessageDraft(chatId: number, draftId: number, text: string, threadId?: number): Promise<boolean> {
    return this.call("sendMessageDraft", {
      chat_id: chatId,
      draft_id: draftId,
      text,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
  }

  sendRichMessage(
    chatId: number,
    richMessage: InputRichMessage,
    options: { threadId?: number; keyboard?: InlineKeyboard } = {},
  ): Promise<TelegramMessage> {
    return this.call("sendRichMessage", {
      chat_id: chatId,
      rich_message: richMessage,
      ...(options.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
      ...(options.keyboard ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
    });
  }

  sendRichMessageDraft(
    chatId: number,
    draftId: number,
    richMessage: InputRichMessage,
    threadId?: number,
  ): Promise<boolean> {
    return this.call("sendRichMessageDraft", {
      chat_id: chatId,
      draft_id: draftId,
      rich_message: richMessage,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  /** Edit text or rich content; pass an empty keyboard to remove an inline keyboard. */
  editMessageText(
    chatId: number,
    messageId: number,
    options: { text?: string; richMessage?: InputRichMessage; keyboard?: InlineKeyboard } = {},
  ): Promise<TelegramMessage | boolean> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(options.richMessage ? { rich_message: options.richMessage } : {}),
      ...(options.keyboard !== undefined ? { reply_markup: { inline_keyboard: options.keyboard } } : {}),
    });
  }

  createForumTopic(chatId: number, name: string): Promise<TelegramForumTopic> {
    return this.call("createForumTopic", { chat_id: chatId, name });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  getFile(fileId: string): Promise<TelegramFile> {
    return this.call("getFile", { file_id: fileId });
  }

  /** Download a file by its file_path (returned by getFile). Not a JSON endpoint. */
  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    const response = await this.fetchImpl(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS),
    });
    if (!response.ok) throw new TelegramApiError(response.status, `file download failed for ${filePath}`);
    return response.arrayBuffer();
  }
}

/**
 * Update-acquisition seam. PollingUpdateSource is the only implementation today;
 * a future shared router daemon (one token owner, many OMP sessions) slots in here
 * without touching bridge logic. Do not build the router until a second consumer exists.
 */
export interface BotUpdateSource {
  readonly running: boolean;
  start(onUpdate: (update: TelegramUpdate) => void | Promise<void>, onError: (error: Error) => void): void;
  stop(): void;
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const RETRY_DELAY_MS = 2000;

export class PollingUpdateSource implements BotUpdateSource {
  #offset = 0;
  #stopped = false;
  #running = false;
  readonly #sleep: Sleep;
  readonly #timeoutSeconds: number;

  constructor(
    private readonly api: TelegramBotApi,
    options: { timeoutSeconds?: number; sleep?: Sleep } = {},
  ) {
    this.#timeoutSeconds = options.timeoutSeconds ?? 30;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  get running(): boolean {
    return this.#running;
  }

  stop(): void {
    this.#stopped = true;
  }

  start(onUpdate: (update: TelegramUpdate) => void | Promise<void>, onError: (error: Error) => void): void {
    if (this.#running) throw new Error("PollingUpdateSource is already running");
    this.#stopped = false;
    this.#running = true;
    void this.#loop(onUpdate, onError);
  }

  async #loop(
    onUpdate: (update: TelegramUpdate) => void | Promise<void>,
    onError: (error: Error) => void,
  ): Promise<void> {
    while (!this.#stopped) {
      try {
        const updates = await this.api.getUpdates(this.#offset, this.#timeoutSeconds);
        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          await onUpdate(update);
        }
      } catch (error) {
        const asError = error instanceof Error ? error : new Error(String(error));
        if (asError instanceof TelegramApiError && asError.isConflict) {
          // Another consumer owns this token — retrying would steal updates back and forth.
          this.#running = false;
          onError(asError);
          return;
        }
        onError(asError);
        await this.#sleep(RETRY_DELAY_MS);
      }
    }
    this.#running = false;
  }
}

/** Split text to fit Telegram's per-message cap, preferring newline boundaries. */
export function chunkText(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (limit <= 0) throw new RangeError(`limit must be positive, got ${limit}`);
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit - 1);
    if (cut <= 0) {
      cut = limit;
    } else {
      cut += 1; // keep the newline at the end of the chunk
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Minimum-spacing scheduler for rate-bucketed calls (drafts, chat actions). */
export class RateLimiter {
  #nextAt = 0;
  readonly #sleep: Sleep;

  constructor(
    private readonly minIntervalMs: number,
    sleep: Sleep = defaultSleep,
  ) {
    this.#sleep = sleep;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#nextAt);
    this.#nextAt = at + this.minIntervalMs;
    const delay = at - now;
    if (delay > 0) await this.#sleep(delay);
  }
}
