import { chunkText, DRAFT_MIN_INTERVAL_MS, RateLimiter, TelegramBotApi, TelegramApiError } from "./bot-api.ts";
import { isRecord } from "./config.ts";
import { escapeHtml } from "./text.ts";

/**
 * Turn streaming, scene-1 anatomy: ONE evolving rich message per turn. The draft grows
 * (thinking block, streamed text, tool-call <details> blocks) and finalizes at turn end.
 *
 * Architecture: extension event handlers are awaited by the agent loop, so handlers here
 * only enqueue actions synchronously; a background drain sends them at Telegram's pace.
 */

/** Rich-message send cap used for chunking; stays under the 32768 API limit. */
const MESSAGE_BUDGET = 30_000;
/** Drafts re-send cumulative content; past this, recompose with tight budgets or the API 400s every update. */
export const DRAFT_BUDGET = 28_000;
/** Drafts re-send cumulative content; keep thinking/output tails small so they stay cheap. */
const THINKING_TAIL = 500;
const TOOL_OUTPUT_LIMIT = 600;
const TOOL_SUMMARY_LIMIT = 80;

export interface ToolCallView {
  id: string;
  name: string;
  summary: string;
  output: string;
  isError: boolean;
  done: boolean;
}

export interface MessageLike {
  role: string;
  content?: unknown;
}

export interface ToolExecutionLike {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export type StreamAction = { kind: "draft"; markdown: string } | { kind: "final"; markdown: string };

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

/** Human one-liner for a tool call: the most identifying argument, first line only. */
export function summarizeToolCall(toolName: string, args: unknown): string {
  const record = isRecord(args) ? args : {};
  for (const key of ["command", "path", "filePath", "pattern", "query", "url", "name"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      const firstLine = value.split("\n", 1)[0].trim();
      return `${toolName} · ${truncate(firstLine, TOOL_SUMMARY_LIMIT)}`;
    }
  }
  return toolName;
}

/** Best-effort plain-text extraction from an AgentToolResult-shaped unknown. */
export function extractToolOutput(result: unknown, limit = TOOL_OUTPUT_LIMIT): string {
  let text = "";
  if (isRecord(result) && Array.isArray(result.content)) {
    text = result.content
      .filter((block): block is ContentBlock => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map(block => block.text as string)
      .join("\n");
  } else if (typeof result === "string") {
    text = result;
  } else if (result !== undefined && result !== null) {
    text = JSON.stringify(result) ?? "";
  }
  return truncate(text, limit);
}

function tail(value: string, limit: number): string {
  return value.length > limit ? `…${value.slice(value.length - limit)}` : value;
}

function toolDetailsMarkdown(tool: ToolCallView, outputLimit: number): string {
  const body = tool.done ? tool.output || "(no output)" : "running…";
  const capped = truncate(body, outputLimit);
  const fence = capped.includes("```") ? "~~~" : "```";
  const errorMark = tool.isError ? " ❌" : "";
  return `<details><summary>⚙️ ${tool.summary}${errorMark}</summary>\n\n${fence}\n${capped}\n${fence}\n\n</details>`;
}

interface ComposeBudget {
  thinking: number;
  text: number;
  toolOutput: number;
}

const FULL_BUDGET: ComposeBudget = { thinking: THINKING_TAIL, text: Number.POSITIVE_INFINITY, toolOutput: TOOL_OUTPUT_LIMIT };
const TIGHT_BUDGET: ComposeBudget = { thinking: 200, text: 8_000, toolOutput: 120 };

/** Pure turn state machine: extension events in, stream actions out. */
export class TurnRenderer {
  #thinking = "";
  #text = "";
  #tools: ToolCallView[] = [];

  reset(): void {
    this.#thinking = "";
    this.#text = "";
    this.#tools = [];
  }

  #composeWith(includeThinking: boolean, budget: ComposeBudget): string {
    const parts: string[] = [];
    if (includeThinking && this.#thinking.length > 0) {
      parts.push(`<tg-thinking>${tail(this.#thinking, budget.thinking)}</tg-thinking>`);
    }
    if (this.#text.length > 0) parts.push(tail(this.#text, budget.text));
    for (const tool of this.#tools) parts.push(toolDetailsMarkdown(tool, budget.toolOutput));
    return parts.join("\n\n");
  }

  #compose(includeThinking: boolean): string {
    const full = this.#composeWith(includeThinking, FULL_BUDGET);
    return full.length <= DRAFT_BUDGET ? full : this.#composeWith(includeThinking, TIGHT_BUDGET);
  }

  messageUpdate(message: MessageLike): StreamAction[] {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
    const blocks = message.content.filter(isRecord) as ContentBlock[];
    this.#thinking = blocks
      .filter(block => block.type === "thinking" && typeof block.thinking === "string")
      .map(block => block.thinking as string)
      .join("\n");
    this.#text = blocks
      .filter(block => block.type === "text" && typeof block.text === "string")
      .map(block => block.text as string)
      .join("\n\n");
    const markdown = this.#compose(true);
    return markdown.length > 0 ? [{ kind: "draft", markdown }] : [];
  }

  toolExecutionStart(event: ToolExecutionLike): StreamAction[] {
    this.#tools.push({
      id: event.toolCallId,
      name: event.toolName,
      summary: summarizeToolCall(event.toolName, event.args),
      output: "",
      isError: false,
      done: false,
    });
    return [{ kind: "draft", markdown: this.#compose(true) }];
  }

  toolExecutionEnd(event: ToolExecutionLike): StreamAction[] {
    const tool = this.#tools.find(candidate => candidate.id === event.toolCallId);
    if (tool) {
      tool.done = true;
      tool.isError = event.isError === true;
      tool.output = extractToolOutput(event.result);
    }
    return [{ kind: "draft", markdown: this.#compose(true) }];
  }

  /** Finalize: thinking is dropped (it is draft-only by design), everything else persists. */
  turnEnd(): StreamAction[] {
    const markdown = this.#compose(false);
    return markdown.length > 0 ? [{ kind: "final", markdown }] : [];
  }
}

/** Plain-text fallback when Telegram rejects markdown (unbalanced fences from agent output). */
function markdownToPlainHtml(markdown: string): string {
  return `<p>${escapeHtml(markdown).replace(/\n/g, "<br/>")}</p>`;
}

/**
 * Effectful driver: drains queued actions against the Bot API with draft coalescing,
 * rate pacing, markdown→plain fallback on 400, and final-message chunking.
 */
export class TelegramTurnStream {
  #queue: StreamAction[] = [];
  #drainPromise: Promise<void> | undefined;
  #draftId = 1;
  readonly #pace: RateLimiter;

  constructor(
    private readonly api: TelegramBotApi,
    private readonly chatId: number,
    private readonly threadId: () => number | undefined,
    private readonly onError: (error: Error) => void = () => {},
    paceMs = DRAFT_MIN_INTERVAL_MS,
  ) {
    this.#pace = new RateLimiter(paceMs);
  }

  push(action: StreamAction): void {
    if (action.kind === "draft") {
      const pending = this.#queue.findIndex(candidate => candidate.kind === "draft");
      if (pending >= 0) this.#queue.splice(pending, 1);
      this.#queue.push(action);
    } else {
      this.#queue = this.#queue.filter(candidate => candidate.kind !== "draft");
      this.#queue.push(action);
    }
    this.#drainPromise ??= this.#drain();
  }

  /** Test/flush seam: resolves when every queued action has been sent. */
  async flush(): Promise<void> {
    while (this.#drainPromise) await this.#drainPromise;
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const action = this.#queue.shift() as StreamAction;
      await this.#pace.wait();
      try {
        if (action.kind === "draft") {
          await this.#sendDraft(action.markdown);
        } else {
          await this.#sendFinal(action.markdown);
        }
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    // No await between the empty-queue check and clearing — pushes here start a fresh drain.
    this.#drainPromise = undefined;
  }

  async #sendDraft(markdown: string): Promise<void> {
    const threadId = this.threadId();
    try {
      await this.api.sendRichMessageDraft(this.chatId, this.#draftId, { markdown }, threadId);
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 400) {
        await this.api.sendRichMessageDraft(this.chatId, this.#draftId, { html: markdownToPlainHtml(markdown) }, threadId);
        return;
      }
      throw error;
    }
  }

  async #sendFinal(markdown: string): Promise<void> {
    this.#draftId += 1; // next turn's drafts get a fresh id
    const threadId = this.threadId();
    for (const chunk of chunkText(markdown, MESSAGE_BUDGET)) {
      try {
        await this.api.sendRichMessage(this.chatId, { markdown: chunk }, { threadId });
      } catch (error) {
        if (error instanceof TelegramApiError && error.status === 400) {
          await this.api.sendRichMessage(this.chatId, { html: markdownToPlainHtml(chunk) }, { threadId });
          continue;
        }
        throw error;
      }
    }
  }
}
