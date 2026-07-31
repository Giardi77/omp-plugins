#!/usr/bin/env bun
/**
 * Live Telegram UI/UX prototype for the OMP bridge — renders candidate turn anatomies,
 * the approval card, and topic binding against a real bot so they can be compared on a phone.
 *
 *   bun plugins/telegram/prototype/run.ts [scene1,scene2,approvals,topics]   (default: all)
 *
 * Token via OMP_TELEGRAM_BOT_TOKEN (bun auto-loads the repo-root .env). If OMP_TELEGRAM_CHAT_ID
 * is set, pairing is skipped; otherwise the harness pairs via the plugin's own code flow.
 */
import {
  DRAFT_MIN_INTERVAL_MS,
  PollingUpdateSource,
  RateLimiter,
  TelegramBotApi,
  type InlineKeyboard,
  type TelegramUpdate,
} from "../src/bot-api.ts";
import { loadBotToken } from "../src/config.ts";
import { generatePairingCode, waitForPairing } from "../src/pairing.ts";

const requestedScenes = (process.argv[2] ?? "all").split(",").map(scene => scene.trim());
const DRAFT_PACE_MS = DRAFT_MIN_INTERVAL_MS + 50;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type UpdateSubscriber = (listener: (update: TelegramUpdate) => void) => () => void;

interface ToolScene {
  summary: string;
  lang: string;
  output: string;
}

/** A realistic mini-turn: the agent fixes a session leak in auth/session.ts. */
const TURN = {
  thinking: "Tracing the token lifecycle through src/auth/session.ts…",
  intro: "I'll trace the session lifecycle first, then patch the leak and run the tests.",
  tools: [
    {
      summary: "⚙️ grep · \"session\" src/auth",
      lang: "",
      output:
        "src/auth/session.ts:44:  const sessions = new Map<string, User>();\nsrc/auth/session.ts:88:  sessions.set(token, user);\nsrc/auth/login.ts:31:  return createSession(user);",
    },
    {
      summary: "⚙️ read · src/auth/session.ts:40-52",
      lang: "ts",
      output:
        "export function closeSession(token: string): void {\n  // BUG: entry is never removed — the map grows forever\n  revoke(token);\n}",
    },
    {
      summary: "⚙️ edit · src/auth/session.ts",
      lang: "diff",
      output: "-  revoke(token);\n+  revoke(token);\n+  sessions.delete(token);",
    },
    {
      summary: "⚙️ bash · bun test",
      lang: "",
      output: " 26 pass\n 0 fail\nRan 26 tests across 4 files. [1.25s]",
    },
  ] satisfies ToolScene[],
  finalMarkdown: [
    "## Fix: session leak in auth",
    "",
    "`closeSession` revoked the token but never dropped the map entry, so every login leaked a `User` object.",
    "",
    "| File | Change |",
    "|:-----|:-------|",
    "| `src/auth/session.ts` | `sessions.delete(token)` on close |",
    "",
    "- [x] Patch applied",
    "- [x] Tests green (26/26)",
  ].join("\n"),
};

function toolDetailsHtml(tool: ToolScene): string {
  const code = tool.lang
    ? `<pre><code class="language-${tool.lang}">${escapeHtml(tool.output)}</code></pre>`
    : `<pre>${escapeHtml(tool.output)}</pre>`;
  return `<details><summary>${escapeHtml(tool.summary)}</summary>${code}</details>`;
}

function toolDetailsMarkdown(tool: ToolScene): string {
  return `<details><summary>${tool.summary}</summary>\n\n\`\`\`${tool.lang}\n${tool.output}\n\`\`\`\n\n</details>`;
}

function toolCardHtml(tool: ToolScene): string {
  return `<p>${escapeHtml(tool.summary)}</p>${toolDetailsHtml(tool)}`;
}

/** Visual separator in the chat so adjacent scenes can't blur together. */
async function banner(api: TelegramBotApi, chatId: number, title: string, subtitle: string): Promise<void> {
  await api.sendRichMessage(chatId, {
    html: `<hr/><h4>🎬 ${escapeHtml(title)}</h4><p><i>${escapeHtml(subtitle)}</i></p><hr/>`,
  });
}

/** Scene 1: the whole turn lives in ONE evolving rich message (draft → finalize). */
async function scene1(api: TelegramBotApi, chatId: number): Promise<void> {
  console.log("[scene1] evolving single message — watch one draft grow into the full turn");
  const pace = new RateLimiter(DRAFT_PACE_MS);
  const draftId = 1 + Math.floor(Math.random() * 2 ** 30);

  let html = `<tg-thinking>${escapeHtml(TURN.thinking)}</tg-thinking>`;
  await pace.wait();
  await api.sendRichMessageDraft(chatId, draftId, { html });

  for (let i = 24; i < TURN.intro.length + 24; i += 24) {
    await pace.wait();
    await api.sendRichMessageDraft(chatId, draftId, { html: `${html}<p>${escapeHtml(TURN.intro.slice(0, i))}</p>` });
  }
  html += `<p>${escapeHtml(TURN.intro)}</p>`;

  for (const tool of TURN.tools) {
    html += toolDetailsHtml(tool);
    await pace.wait();
    await api.sendRichMessageDraft(chatId, draftId, { html });
  }

  await api.sendRichMessage(chatId, {
    markdown: `${TURN.intro}\n\n${TURN.tools.map(toolDetailsMarkdown).join("\n\n")}\n\n${TURN.finalMarkdown}`,
  });
  console.log("[scene1] finalized — thinking block dropped on persist, as designed");
}

/** Scene 2: draft for streaming text, a separate card per tool call, final answer message. */
async function scene2(api: TelegramBotApi, chatId: number): Promise<void> {
  console.log("[scene2] segmented — draft for text, separate tool cards, final message");
  const pace = new RateLimiter(DRAFT_PACE_MS);
  const draftId = 1 + Math.floor(Math.random() * 2 ** 30);

  await api.sendRichMessageDraft(chatId, draftId, { html: `<tg-thinking>${escapeHtml(TURN.thinking)}</tg-thinking>` });
  await sleep(1200);
  for (let i = 24; i < TURN.intro.length + 24; i += 24) {
    await pace.wait();
    await api.sendRichMessageDraft(chatId, draftId, { html: `<p>${escapeHtml(TURN.intro.slice(0, i))}</p>` });
  }
  await api.sendRichMessage(chatId, { markdown: TURN.intro });

  for (const tool of TURN.tools) {
    await api.sendRichMessage(chatId, { html: toolCardHtml(tool) });
    await sleep(700);
  }
  await api.sendRichMessage(chatId, {
    markdown: `${TURN.finalMarkdown}\n\n---\n\n_4 tool calls · 1 file changed · tests 26/26 — delivered as a separate final message_`,
  });
  console.log("[scene2] done");
}

/** Scene 3: the rich approval card with inline keyboard, resolved by a real tap. */
async function scene3(api: TelegramBotApi, chatId: number, subscribe: UpdateSubscriber): Promise<void> {
  const command = "rm -rf build && bun run build";
  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Approve", callback_data: "approve" },
      { text: "❌ Deny", callback_data: "deny" },
    ],
    [{ text: "🔓 Always allow", callback_data: "always" }],
  ];
  const card = await api.sendRichMessage(
    chatId,
    {
      html: `<h4>⚠️ Approval required</h4><p><b>bash</b> · turn 3</p><pre><code class="language-bash">${escapeHtml(command)}</code></pre><footer>Not on the session allow-list</footer>`,
    },
    { keyboard },
  );
  console.log("[approvals] card sent — tap a button on your phone (120s timeout)");

  const decision = await waitForCallback(subscribe, card.message_id, 120_000);
  if (!decision) {
    await api.editMessageText(chatId, card.message_id, {
      richMessage: { html: `<p>⌛ Approval timed out — treated as denied.</p>` },
      keyboard: [],
    });
    console.log("[approvals] timed out");
    return;
  }
  await api.answerCallbackQuery(decision.queryId, `You chose: ${decision.data}`);
  const banner =
    decision.data === "approve" ? "✅ Approved" : decision.data === "always" ? "🔓 Always allowed (session policy)" : "❌ Denied";
  await api.editMessageText(chatId, card.message_id, {
    richMessage: { html: `<p>${banner}</p><pre><code class="language-bash">${escapeHtml(command)}</code></pre>` },
    keyboard: [],
  });
  console.log(`[approvals] resolved: ${decision.data}`);
}

async function waitForCallback(
  subscribe: UpdateSubscriber,
  messageId: number,
  timeoutMs: number,
): Promise<{ queryId: string; data: string } | null> {
  const { promise, resolve } = Promise.withResolvers<{ queryId: string; data: string } | null>();
  const timer = setTimeout(() => {
    unsubscribe();
    resolve(null);
  }, timeoutMs);
  const unsubscribe = subscribe(update => {
    const query = update.callback_query;
    if (!query || query.message?.message_id !== messageId) return;
    clearTimeout(timer);
    unsubscribe();
    resolve({ queryId: query.id, data: query.data ?? "" });
  });
  return promise;
}

/** Scene 4: one topic per session in the bot DM, streamed turn inside a topic, inbound binding. */
async function scene4(api: TelegramBotApi, chatId: number, subscribe: UpdateSubscriber): Promise<void> {
  console.log("[topics] creating two session topics in this DM");
  let threadA: number;
  let threadB: number;
  try {
    threadA = (await api.createForumTopic(chatId, "omp-plugins · fix session leak")).message_thread_id;
    threadB = (await api.createForumTopic(chatId, "omp-plugins · docs sweep")).message_thread_id;
  } catch (error) {
    console.error(
      "[topics] createForumTopic failed — enable forum-topic mode for private chats in the BotFather Mini App, then retry.",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const pace = new RateLimiter(DRAFT_PACE_MS);
  const draftId = 1 + Math.floor(Math.random() * 2 ** 30);
  await api.sendRichMessageDraft(chatId, draftId, { html: `<tg-thinking>${escapeHtml(TURN.thinking)}</tg-thinking>` }, threadA);
  await pace.wait();
  await api.sendRichMessageDraft(chatId, draftId, { html: `<p>${escapeHtml(TURN.intro)}</p>` }, threadA);
  await api.sendRichMessage(chatId, { markdown: TURN.finalMarkdown }, { threadId: threadA });
  await api.sendRichMessage(
    chatId,
    { markdown: "## Docs sweep\n\n- [x] README refreshed\n- [ ] API docs pending" },
    { threadId: threadB },
  );

  console.log("[topics] reply in either topic (or General) within 90s to see the binding");
  const unsubscribe = subscribe(update => {
    const message = update.message;
    if (!message?.text || message.from?.is_bot) return;
    const threadId = message.message_thread_id;
    const binding = threadId === threadA ? "fix session leak" : threadId === threadB ? "docs sweep" : "current session (General)";
    void api.sendMessage(
      chatId,
      `🔗 topic ${threadId ?? "general"} → ${binding}\nwould steer: "${message.text}"`,
      threadId !== undefined ? { threadId } : {},
    );
  });
  await sleep(90_000);
  unsubscribe();
  console.log("[topics] done");
}

async function main(): Promise<void> {
  const token = await loadBotToken();
  if (!token) {
    console.error("Missing token: set OMP_TELEGRAM_BOT_TOKEN (repo-root .env works).");
    process.exit(1);
  }
  const api = new TelegramBotApi(token);
  const me = await api.getMe();
  console.log(`bot: @${me.username ?? me.first_name}`);

  const listeners = new Set<(update: TelegramUpdate) => void>();
  const source = new PollingUpdateSource(api, { timeoutSeconds: 25 });
  source.start(
    update => {
      for (const listener of [...listeners]) listener(update);
    },
    error => console.error(`[source] ${error.message}`),
  );
  const subscribe: UpdateSubscriber = listener => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  let chatId: number;
  const envChatId = process.env.OMP_TELEGRAM_CHAT_ID;
  if (envChatId) {
    chatId = Number(envChatId);
    console.log(`chat: ${chatId} (from env, pairing skipped)`);
  } else {
    const code = generatePairingCode();
    console.log(`pairing: send this code to @${me.username}: ${code} (waiting up to 5 minutes)`);
    chatId = (await waitForPairing(subscribe, code, { timeoutMs: 300_000 })).chatId;
    console.log(`paired: chat ${chatId}`);
  }

  for (const scene of requestedScenes) {
    if (scene === "scene1" || scene === "all") {
      await banner(api, chatId, "Scene 1 — one evolving message", "Thinking, streaming text and tool calls all live in a SINGLE message that grows, then finalizes.");
      await scene1(api, chatId);
    }
    if (scene === "scene2" || scene === "all") {
      await banner(api, chatId, "Scene 2 — segmented", "Text streams in a draft, each tool call is its own message, the answer lands separately.");
      await scene2(api, chatId);
    }
    if (scene === "approvals" || scene === "all") {
      await banner(api, chatId, "Scene 3 — approval card", "Tap a button; the card resolves in place.");
      await scene3(api, chatId, subscribe);
    }
    if (scene === "topics" || scene === "all") {
      await banner(api, chatId, "Scene 4 — session topics", "One topic per session in this DM; reply in a topic to see the binding.");
      await scene4(api, chatId, subscribe);
    }
    await sleep(2500);
  }

  source.stop();
  console.log("done.");
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
