import type { TelegramBotApi } from "./bot-api.ts";

/**
 * Topic routing: one forum topic per OMP session in the bot DM, as progressive enhancement.
 * Detection happens once at connect time via getMe().has_topics_enabled — without Threaded
 * Mode the router is inert ("flat mode") and every caller gets undefined thread ids.
 */

const TOPIC_NAME_LIMIT = 128;

export interface TopicStore {
  load(): Promise<Record<string, number>>;
  save(topics: Record<string, number>): Promise<void>;
}

export class TopicRouter {
  readonly #topics: Map<string, number>;

  private constructor(
    private readonly api: TelegramBotApi | null,
    private readonly chatId: number,
    private readonly store: TopicStore,
    initial: Record<string, number>,
  ) {
    this.#topics = new Map(Object.entries(initial));
  }

  static async connect(api: TelegramBotApi, chatId: number, store: TopicStore): Promise<TopicRouter> {
    const [initial, me] = await Promise.all([store.load(), api.getMe()]);
    return new TopicRouter(me.has_topics_enabled === true ? api : null, chatId, store, initial);
  }

  get topicsEnabled(): boolean {
    return this.api !== null;
  }

  threadFor(sessionId: string): number | undefined {
    return this.#topics.get(sessionId);
  }

  /** Reverse lookup for inbound routing: which session owns this topic thread, if any. */
  sessionFor(threadId: number): string | undefined {
    for (const [sessionId, id] of this.#topics) {
      if (id === threadId) return sessionId;
    }
    return undefined;
  }

  /** Create the session's topic on first use; no-op (undefined) in flat mode. */
  async ensureTopic(sessionId: string, name: string): Promise<number | undefined> {
    if (!this.api) return undefined;
    const existing = this.#topics.get(sessionId);
    if (existing !== undefined) return existing;
    const topic = await this.api.createForumTopic(this.chatId, name.slice(0, TOPIC_NAME_LIMIT) || "session");
    this.#topics.set(sessionId, topic.message_thread_id);
    await this.store.save(Object.fromEntries(this.#topics));
    return topic.message_thread_id;
  }
}
