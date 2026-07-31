import { TelegramBotApi, type InlineKeyboard } from "./bot-api.ts";
import type { ApprovalDecision, ApprovalRequest, ApprovalSurface } from "./approvals.ts";
import type { UpdateSubscriber } from "./pairing.ts";
import { escapeHtml } from "./text.ts";

/**
 * Shared settlement state for one approval request. The first verdict to land (a surface
 * answer or the gate's own timeout) wins; every surface learns it through the cell, so a
 * card can always show the verdict that actually happened — never a stale or late one.
 */
export interface SettleCell {
  readonly label: string | undefined;
  onSettled(cb: (label: string) => void): void;
  settle(label: string): void;
}

export function createSettleCell(): SettleCell {
  let label: string | undefined;
  const waiters = new Set<(label: string) => void>();
  return {
    get label() {
      return label;
    },
    onSettled(cb) {
      if (label !== undefined) cb(label);
      else waiters.add(cb);
    },
    settle(next) {
      if (label !== undefined) return;
      label = next;
      for (const cb of [...waiters]) cb(next);
      waiters.clear();
    },
  };
}

function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === "approve" || value === "deny" || value === "always";
}

/**
 * Telegram approval surface: rich card with an inline keyboard; the first tap resolves.
 *
 * Truthfulness contract: `settledElsewhere` reports the verdict that already settled this
 * request on another surface (TUI) or by gate timeout. A tap that arrives after settlement
 * edits the card with THAT verdict — never the tapped one — so phone and agent can never
 * disagree about whether a call ran.
 */
export function makeTelegramApprovalSurface(deps: {
  api: TelegramBotApi;
  chatId: number;
  threadId: () => number | undefined;
  subscribe: UpdateSubscriber;
  settleCell: SettleCell;
}): ApprovalSurface {
  const { api, chatId, threadId, subscribe, settleCell } = deps;
  return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
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
        html: `<h4>⚠️ Approval required</h4><p><b>${escapeHtml(request.toolName)}</b></p><pre>${escapeHtml(request.summary)}</pre>`,
      },
      { threadId: threadId(), keyboard },
    );

    const editCard = (html: string) =>
      api
        .editMessageText(chatId, card.message_id, {
          richMessage: { html: `${html}<pre>${escapeHtml(request.summary)}</pre>` },
          keyboard: [],
        })
        .catch(() => {});

    let settled = false;
    const { promise, resolve } = Promise.withResolvers<{
      queryId: string;
      decision: ApprovalDecision;
      elsewhere: string | undefined;
    }>();
    const unsubscribe = subscribe(update => {
      const query = update.callback_query;
      if (!query?.data || !isApprovalDecision(query.data)) return;
      if (query.message?.message_id !== card.message_id || settled) return;
      settled = true;
      unsubscribe();
      resolve({ queryId: query.id, decision: query.data, elsewhere: settleCell.label });
    });
    settleCell.onSettled(label => {
      if (settled) return;
      settled = true;
      unsubscribe();
      void editCard(`<p>${escapeHtml(label)}</p>`);
      // The surface promise intentionally stays pending: the gate's race already has
      // its winner, and resolving here could only inject a phantom decision.
    });

    const { queryId, decision, elsewhere } = await promise;
    if (elsewhere !== undefined) {
      await api.answerCallbackQuery(queryId, "Already resolved.").catch(() => {});
      await editCard(`<p>${escapeHtml(elsewhere)}</p>`);
      return decision; // the gate's race already settled — this return is ignored
    }

    await api.answerCallbackQuery(queryId, `You chose: ${decision}`).catch(() => {});
    const banner = decision === "approve" ? "✅ Approved" : decision === "always" ? "🔓 Always allowed" : "❌ Denied";
    await editCard(`<p>${banner}</p>`);
    return decision;
  };
}

export interface SelectUi {
  select(title: string, options: string[]): Promise<string | undefined>;
}

/** TUI approval surface: a plain select dialog. An aborted dialog counts as deny (fail-closed). */
export function makeTuiApprovalSurface(ui: SelectUi): ApprovalSurface {
  return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const choice = await ui.select(`Approve tool call?\n${request.summary}`, ["Approve", "Deny", "Always allow"]);
    if (choice === "Approve") return "approve";
    if (choice === "Always allow") return "always";
    return "deny";
  };
}
