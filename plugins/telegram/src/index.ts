import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PollingUpdateSource, TelegramBotApi, type TelegramUpdate } from "./bot-api.ts";
import { loadPluginState, loadTopics, saveBotToken, savePairedChat, saveTopics } from "./config.ts";
import { messageToPrompt } from "./inbound.ts";
import { acquireInstanceLock, InstanceLockedError } from "./lock.ts";
import { generatePairingCode, PairingTimeoutError, waitForPairing } from "./pairing.ts";
import { TelegramTurnStream, TurnRenderer } from "./stream.ts";
import { escapeHtml } from "./text.ts";
import { TopicRouter, type TopicStore } from "./topics.ts";

type BridgeStatus =
  | { state: "off" }
  | { state: "polling"; botUsername?: string }
  | { state: "locked"; holderPid: number }
  | { state: "error"; detail: string };

const PAIRING_TIMEOUT_MS = 120_000;

export default function telegramExtension(pi: ExtensionAPI): void {
  pi.setLabel("Telegram");

  let status: BridgeStatus = { state: "off" };
  let botApi: TelegramBotApi | undefined;
  let source: PollingUpdateSource | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  let pairedChatId: number | undefined;
  let bootstrapped = false;
  const updateListeners = new Set<(update: TelegramUpdate) => unknown>();

  // Post-pairing runtime: created once a chat is paired, reset on session switch.
  let topicRouter: TopicRouter | undefined;
  let turnStream: TelegramTurnStream | undefined;
  let renderer: TurnRenderer | undefined;
  let currentSessionId: string | undefined;

  const subscribe = (listener: (update: TelegramUpdate) => unknown) => {
    updateListeners.add(listener);
    return () => {
      updateListeners.delete(listener);
    };
  };

  function reportError(context: string, error: unknown): void {
    pi.logger.error(context, { error: error instanceof Error ? error.message : String(error) });
  }

  function dispatch(update: TelegramUpdate): void {
    for (const listener of [...updateListeners]) {
      try {
        void Promise.resolve(listener(update)).catch(error => reportError("Telegram update listener failed", error));
      } catch (error) {
        reportError("Telegram update listener failed", error);
      }
    }
  }

  /** Inbound driving: text becomes a prompt, photos become image content — from the paired
   *  chat only, and only in the General topic or the current session's bound topic. */
  async function inbound(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || message.from?.is_bot) return;
    if (pairedChatId === undefined || message.chat.id !== pairedChatId) return;
    if (!botApi) return;
    const threadId = message.message_thread_id;
    if (threadId !== undefined && topicRouter?.topicsEnabled && topicRouter.sessionFor(threadId) !== currentSessionId) {
      return; // a topic bound to another (or no current) session must not steer this one
    }
    const prompt = await messageToPrompt(botApi, message);
    if (prompt !== undefined) pi.sendUserMessage(prompt);
  }

  async function startBridge(token: string, root: string): Promise<void> {
    if (source?.running) return;
    try {
      releaseLock = await acquireInstanceLock(path.join(root, ".omp", "telegram.lock"));
    } catch (error) {
      if (error instanceof InstanceLockedError) {
        status = { state: "locked", holderPid: error.holderPid };
        return;
      }
      throw error;
    }
    const api = new TelegramBotApi(token);
    botApi = api;
    source = new PollingUpdateSource(api);
    source.start(dispatch, error => {
      status = { state: "error", detail: error.message };
      reportError("Telegram update source stopped", error);
    });
    updateListeners.add(inbound);
    status = { state: "polling" };
    api
      .getMe()
      .then(me => {
        if (status.state === "polling") status = { state: "polling", ...(me.username ? { botUsername: me.username } : {}) };
      })
      .catch(() => {});
  }

  /** Post-pairing runtime: topic routing, turn streaming, and the approval gate. */
  async function initRuntime(root: string): Promise<void> {
    if (!botApi || pairedChatId === undefined || turnStream) return;
    const api = botApi;
    const chatId = pairedChatId;
    const store: TopicStore = {
      load: () => loadTopics(root),
      save: topics => saveTopics(root, topics),
    };
    topicRouter = await TopicRouter.connect(api, chatId, store);
    renderer = new TurnRenderer();
    turnStream = new TelegramTurnStream(
      api,
      chatId,
      () => (currentSessionId ? topicRouter?.threadFor(currentSessionId) : undefined),
      error => reportError("Telegram stream failed", error),
    );
  }

  async function ensureSessionTopic(): Promise<void> {
    if (!topicRouter?.topicsEnabled || !currentSessionId) return;
    const name = pi.getSessionName() ?? `session ${currentSessionId.slice(0, 8)}`;
    await topicRouter.ensureTopic(currentSessionId, name);
  }

  /** Headless/RPC sessions never poll: two headless agents on one machine would 409-storm. */
  async function bootstrap(cwd: string): Promise<void> {
    if (bootstrapped) return;
    bootstrapped = true;
    try {
      const state = await loadPluginState(cwd);
      if (state.chatId !== undefined) pairedChatId = state.chatId;
      if (!state.botToken) return; // not set up yet — /telegram-setup finishes the job
      await startBridge(state.botToken, state.projectRoot);
      await initRuntime(state.projectRoot);
    } catch (error) {
      status = { state: "error", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  function statusDetail(): string {
    switch (status.state) {
      case "off":
        return "off (not set up — run /telegram-setup)";
      case "polling":
        return `polling${status.botUsername ? ` as @${status.botUsername}` : ""}${
          pairedChatId !== undefined ? `, paired chat ${pairedChatId}` : ", unpaired"
        }${topicRouter?.topicsEnabled ? ", topics on" : ", flat mode"}`;
      case "locked":
        return `blocked: another OMP session (pid ${status.holderPid}) owns this bot`;
      case "error":
        return `error: ${status.detail}`;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    currentSessionId = ctx.sessionManager.getSessionId();
    await bootstrap(ctx.cwd);
    await ensureSessionTopic();
  });

  pi.on("session_switch", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    renderer?.reset();
    await ensureSessionTopic();
  });

  pi.on("session_shutdown", async () => {
    source?.stop();
    await releaseLock?.();
    source = undefined;
    releaseLock = undefined;
  });

  pi.on("turn_start", () => {
    renderer?.reset();
  });

  pi.on("message_update", event => {
    if (!renderer || !turnStream) return;
    for (const action of renderer.messageUpdate(event.message)) turnStream.push(action);
  });

  pi.on("tool_execution_start", event => {
    if (!renderer || !turnStream) return;
    for (const action of renderer.toolExecutionStart(event)) turnStream.push(action);
  });

  pi.on("tool_execution_end", event => {
    if (!renderer || !turnStream) return;
    for (const action of renderer.toolExecutionEnd(event)) turnStream.push(action);
  });

  pi.on("turn_end", () => {
    if (!renderer || !turnStream) return;
    for (const action of renderer.turnEnd()) turnStream.push(action);
  });

  // Advisor cards arrive as custom transcript messages (role "custom", customType "advisor")
  // and are mirrored read-only. Preserved cards fire start+end, steered cards may fire only
  // start — listen on both and dedup on timestamp+content so each card mirrors exactly once.
  const mirroredAdvisories = new Set<string>();
  const mirrorAdvisorCard = async (message: { role: string; customType?: unknown; content?: unknown; timestamp?: unknown }): Promise<void> => {
    if (message.role !== "custom" || message.customType !== "advisor") return;
    if (!botApi || pairedChatId === undefined) return;
    if (typeof message.content !== "string" || message.content.length === 0) return;
    const key = `${String(message.timestamp)}:${message.content}`;
    if (mirroredAdvisories.has(key)) return;
    if (mirroredAdvisories.size > 200) mirroredAdvisories.clear();
    mirroredAdvisories.add(key);
    const threadId = currentSessionId ? topicRouter?.threadFor(currentSessionId) : undefined;
    const body = escapeHtml(message.content.length > 4000 ? `${message.content.slice(0, 4000)}…` : message.content).replace(/\n/g, "<br/>");
    await botApi
      .sendRichMessage(pairedChatId, { html: `<p>🧭 <b>Advisor</b></p><blockquote>${body}</blockquote>` }, { threadId })
      .catch(error => reportError("Telegram advisor mirror failed", error));
  };
  pi.on("message_start", event => void mirrorAdvisorCard(event.message));
  pi.on("message_end", event => void mirrorAdvisorCard(event.message));

  // Approvals are NOT gated by this plugin: yolo means trust, and built-in modes prompt
  // at the terminal. Approval events are mirrored read-only so the phone stays informed.
  // Interactive remote approval needs the upstream dialog-seam PR (decision-returning handlers).
  pi.on("tool_approval_requested", async event => {
    if (!botApi || pairedChatId === undefined) return;
    const threadId = currentSessionId ? topicRouter?.threadFor(currentSessionId) : undefined;
    const reason = event.reason ? `<p>${escapeHtml(event.reason)}</p>` : "";
    await botApi
      .sendRichMessage(
        pairedChatId,
        { html: `<p>⚠️ <b>Approval requested at the terminal</b></p><pre>${escapeHtml(event.toolName)}</pre>${reason}` },
        { threadId },
      )
      .catch(error => reportError("Telegram approval mirror failed", error));
  });

  pi.on("tool_approval_resolved", async event => {
    if (!botApi || pairedChatId === undefined) return;
    const threadId = currentSessionId ? topicRouter?.threadFor(currentSessionId) : undefined;
    const verdict = event.approved ? "✅ Approved" : "❌ Denied";
    await botApi
      .sendRichMessage(pairedChatId, { html: `<p>${verdict} — <b>${escapeHtml(event.toolName)}</b></p>` }, { threadId })
      .catch(error => reportError("Telegram approval mirror failed", error));
  });

  pi.registerCommand("telegram-setup", {
    description: "Pair this project with a Telegram bot",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/telegram-setup requires the interactive OMP UI.", "error");
        return;
      }

      const token = await ctx.ui.input("Telegram bot token (from @BotFather):");
      if (!token?.trim()) {
        ctx.ui.notify("Telegram setup cancelled.", "info");
        return;
      }

      const api = new TelegramBotApi(token.trim());
      let botUsername: string;
      try {
        botUsername = (await api.getMe()).username ?? "unknown";
      } catch (error) {
        ctx.ui.notify(`Token rejected by Telegram: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      await saveBotToken(token.trim());
      const state = await loadPluginState(ctx.cwd);
      await startBridge(token.trim(), state.projectRoot);
      if (!source?.running) {
        ctx.ui.notify(`Cannot pair right now: ${statusDetail()}`, "error");
        return;
      }

      const code = generatePairingCode();
      ctx.ui.notify(`Send this code to @${botUsername} on Telegram within 2 minutes: ${code}`, "info");
      try {
        const result = await waitForPairing(subscribe, code, { timeoutMs: PAIRING_TIMEOUT_MS });
        pairedChatId = result.chatId;
        await savePairedChat(state.projectRoot, result.chatId);
        await initRuntime(state.projectRoot);
        await ensureSessionTopic();
        ctx.ui.notify(
          `Paired with @${result.username ?? result.userId}. Messages in that chat now drive this session.`,
          "info",
        );
      } catch (error) {
        if (error instanceof PairingTimeoutError) {
          ctx.ui.notify("Pairing timed out — run /telegram-setup to try again.", "warning");
        } else {
          throw error;
        }
      }
    },
  });

  pi.registerCommand("telegram-status", {
    description: "Show Telegram bridge state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Telegram bridge: ${statusDetail()}`, "info");
    },
  });
}
