import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PollingUpdateSource, TelegramBotApi, type TelegramUpdate } from "./bot-api.ts";
import { loadPluginState, loadTopics, saveBotToken, savePairedChat, saveTopics } from "./config.ts";
import { messageToPrompt } from "./inbound.ts";
import { acquireInstanceLock, InstanceLockedError } from "./lock.ts";
import { generatePairingCode, PairingTimeoutError, waitForPairing } from "./pairing.ts";
import { ApprovalGate, type ApprovalDecision, type ApprovalSurface } from "./approvals.ts";
import { TelegramTurnStream, TurnRenderer } from "./stream.ts";
import { createSettleCell, makeTelegramApprovalSurface, makeTuiApprovalSurface } from "./surfaces.ts";
import { TopicRouter, type TopicStore } from "./topics.ts";

type BridgeStatus =
  | { state: "off" }
  | { state: "polling"; botUsername?: string }
  | { state: "locked"; holderPid: number }
  | { state: "error"; detail: string };

const PAIRING_TIMEOUT_MS = 120_000;

function decisionLabel(decision: ApprovalDecision): string {
  if (decision === "approve") return "✅ Approved";
  if (decision === "always") return "🔓 Always allowed";
  return "❌ Denied";
}

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
  let approvalGate: ApprovalGate | undefined;
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
    approvalGate = new ApprovalGate();
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
    approvalGate = new ApprovalGate();
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

  // The plugin-owned approval gate. Requires tools.approvalMode: yolo — otherwise the
  // built-in prompt fires right after ours and every call double-prompts.
  pi.on("tool_call", async (event, ctx) => {
    if (!approvalGate) return;

    // Shared settle cell: whichever verdict lands first (a surface answer or the gate's
    // own timeout) becomes the label the Telegram card shows — so phone and terminal
    // can never disagree about a call's fate, and no card leaks its listener.
    const settleCell = createSettleCell();
    const surfaces: Array<ApprovalSurface | undefined> = [];

    if (botApi && pairedChatId !== undefined) {
      const api = botApi;
      const chatId = pairedChatId;
      const telegram = makeTelegramApprovalSurface({
        api,
        chatId,
        threadId: () => (currentSessionId ? topicRouter?.threadFor(currentSessionId) : undefined),
        subscribe,
        settleCell,
      });
      surfaces.push(async request => {
        const decision = await telegram(request);
        settleCell.settle(decisionLabel(decision));
        return decision;
      });
    }
    if (ctx.hasUI) {
      const tui = makeTuiApprovalSurface(ctx.ui);
      surfaces.push(async request => {
        const decision = await tui(request);
        settleCell.settle(decisionLabel(decision));
        return decision;
      });
    }

    const verdict = await approvalGate.decide(
      { toolName: event.toolName, args: "input" in event ? event.input : undefined },
      surfaces,
    );
    if (settleCell.label === undefined) {
      settleCell.settle(
        verdict?.block ? (verdict.reason?.includes("timed out") ? "⌛ Timed out — treated as denied" : "❌ Denied") : "✅ Resolved (allowed)",
      );
    }
    return verdict;
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
