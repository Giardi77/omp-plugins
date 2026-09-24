import type { Component, TUI } from "@oh-my-pi/pi-tui";
import {
  Ellipsis,
  Input,
  SelectList,
  getSymbolTheme,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type SelectItem,
  type SelectListTheme,
} from "@oh-my-pi/pi-tui";
import { OverlayPanel } from "@oh-my-pi/pi-tui/chrome";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { StoredLesson } from "./lessons";
import { messageOf } from "./util";

/**
 * `/distill review` — the only path that decides a proposed lesson (ADR-0010). The window owns
 * nothing but the decision loop: an accepted lesson is written by the caller through `accept`,
 * a denied one is recorded through `deny`, and a decided row leaves the list. Anything untouched
 * stays proposed. The interaction is one component so it can be driven by `handleInput` in a
 * test, and no nested dialog ever opens: review is terminal-only, and RPC's `custom` is a stub.
 */

export interface ReviewEntry {
  lesson: StoredLesson;
  /** The exact text an approval appends (or the whole file when minting). */
  preview: string;
  /** Set when the lesson cannot be written as it stands (missing target, bad slug, size cap, ...). */
  blocked?: string;
  /** The overlap check's lines, verbatim (`existing skills: ...` / `existing agents: ...`). */
  context?: string;
}

export interface ReviewOutcome {
  accepted: string[];
  denied: string[];
  quit: boolean;
}

export interface ReviewHandlers {
  /** Resolves with an error message when the write/decision failed, else undefined. */
  accept(lesson: StoredLesson): Promise<string | undefined>;
  deny(lesson: StoredLesson, reason: string | undefined): Promise<string | undefined>;
}

/** `Theme` from pi-tui, narrowed to what the window paints with. */
export interface ReviewTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

type StatusColor = "muted" | "success" | "error" | "warning";

/** Chrome plus the detail pane, the status line and the key hints below the list. */
const RESERVED_LINES = 16;
/** A skill body, a minted file and a citation block are quoted from the head only. */
const PREVIEW_LINES = 12;
const CITATION_LINES = 12;

function color(theme: ReviewTheme, name: string, text: string): string {
  try {
    return theme.fg(name, text);
  } catch {
    return text;
  }
}

function muted(theme: ReviewTheme, text: string): string {
  return color(theme, "muted", text);
}

function selected(theme: ReviewTheme, text: string): string {
  try {
    return theme.bg("selectedBg", text);
  } catch {
    return text;
  }
}

function bold(theme: ReviewTheme, text: string): string {
  try {
    return theme.bold(text);
  } catch {
    return text;
  }
}

/** `SelectList` paints with the active theme; the window's theme keeps both halves consistent. */
function selectListTheme(theme: ReviewTheme): SelectListTheme {
  return {
    selectedPrefix: text => selected(theme, text),
    selectedText: text => selected(theme, text),
    description: text => muted(theme, text),
    scrollInfo: text => muted(theme, text),
    noMatch: text => muted(theme, text),
    symbols: getSymbolTheme(),
  };
}

/** Quote `lines` from the head, naming how much was left out. */
function capped(lines: string[], limit: number, note: (hidden: number) => string): string[] {
  return lines.length <= limit ? lines : [...lines.slice(0, limit), note(lines.length - limit)];
}

export class ReviewWindow implements Component {
  #entries: ReviewEntry[];
  #panel: OverlayPanel;
  #list: SelectList;
  #reason = new Input();
  /** Set while the one-line reason prompt is open; the denied lesson is the one named here. */
  #denying: ReviewEntry | undefined;
  #selectedIndex = 0;
  /** True while a handler is in flight, so a second keypress cannot duplicate a write. */
  #pending = false;
  /** The in-flight decision, so quitting cannot outrun the write it started. */
  #inFlight: Promise<void> | undefined;
  /** A second `a` that arrived mid-write: the operator meant the next row, so it is replayed. */
  #queuedAccept = false;
  #status = "";
  #statusColor: StatusColor = "muted";
  #outcome: ReviewOutcome = { accepted: [], denied: [], quit: false };

  constructor(
    entries: ReviewEntry[],
    private readonly theme: ReviewTheme,
    private readonly requestRender: () => void,
    private readonly done: (outcome: ReviewOutcome) => void,
    private readonly handlers: ReviewHandlers,
  ) {
    // Undecided lessons only: a decided lesson is never listed, let alone decided twice.
    this.#entries = entries.filter(entry => entry.lesson.state === "proposed");
    this.#panel = new OverlayPanel("Distill review");
    const terminalRows = process.stdout.rows || 24;
    const maxVisible = Math.max(1, Math.min(this.#entries.length, terminalRows - RESERVED_LINES));
    // No search (the rows are acted on by key, not filtered) and no wrap-around: a stray arrow
    // must never point `a` at the first lesson after the last one.
    this.#list = new SelectList(this.#items(), maxVisible, selectListTheme(theme), {
      search: "never",
      wrapNavigation: false,
    });
    this.#list.onSelectionChange = item => {
      const index = this.#entries.findIndex(entry => entry.lesson.id === item.value);
      if (index !== -1) this.#selectedIndex = index;
      this.requestRender();
    };
    this.#reason.prompt = "reason: ";
    this.#reason.onSubmit = value => this.#confirmDeny(value);
    this.#panel.addChild({ render: (width: number) => this.#renderBody(width) });
  }

  invalidate(): void {
    // Rendering is derived from the entries and the current selection.
  }

  render(width: number): readonly string[] {
    return this.#panel.render(width);
  }

  handleInput(data: string): void {
    if (this.#denying !== undefined) {
      if (matchesKey(data, "escape") || matchesKey(data, "esc") || matchesKey(data, "ctrl+c")) {
        this.#denying = undefined;
        this.requestRender();
        return;
      }
      this.#reason.handleInput(data);
      this.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "esc") || matchesKey(data, "ctrl+c") || data === "q") {
      this.#finish();
      return;
    }

    if (data === "a") {
      this.#accept();
      return;
    }

    if (data === "d") {
      this.#beginDeny();
      return;
    }

    // The list owns ↑/↓ and paging; j/k are the same moves under the window's keys.
    if (data === "j") this.#list.handleInput("\x1b[B");
    else if (data === "k") this.#list.handleInput("\x1b[A");
    else this.#list.handleInput(data);
    this.requestRender();
  }

  #current(): ReviewEntry | undefined {
    return this.#entries[this.#selectedIndex];
  }

  #items(): SelectItem[] {
    return this.#entries.map(entry => ({
      value: entry.lesson.id,
      label: entry.lesson.title,
      description: `${entry.lesson.kind} · ${entry.lesson.target}${entry.blocked === undefined ? "" : " · blocked"}`,
    }));
  }

  #accept(): void {
    const entry = this.#current();
    if (entry === undefined) return;
    if (this.#pending) {
      this.#queuedAccept = true;
      return;
    }

    if (entry.blocked !== undefined) {
      this.#setStatus(`cannot write: ${entry.blocked}`, "warning");
      return;
    }

    const lesson = entry.lesson;
    this.#inFlight = this.#decide(entry, "accepted", () => this.handlers.accept(lesson), `accepted ${lesson.id}`);
  }

  #beginDeny(): void {
    const entry = this.#current();
    if (entry === undefined || this.#pending) return;

    this.#denying = entry;
    this.#reason.setValue("");
    this.requestRender();
  }

  #confirmDeny(value: string): void {
    const entry = this.#denying;
    this.#denying = undefined;
    if (entry === undefined) return;

    // An empty prompt means "no reason given", not an empty reason.
    const reason = value.trim() === "" ? undefined : value.trim();
    const lesson = entry.lesson;
    this.#inFlight = this.#decide(
      entry,
      "denied",
      () => this.handlers.deny(lesson, reason),
      `denied ${lesson.id}${reason === undefined ? "" : `: ${reason}`}`,
    );
  }

  /** A failed write or decision keeps the row in the list and shows what went wrong. */
  async #decide(
    entry: ReviewEntry,
    kind: "accepted" | "denied",
    decision: () => Promise<string | undefined>,
    success: string,
  ): Promise<void> {
    this.#pending = true;
    let failure: string | undefined;
    try {
      failure = await decision();
    } catch (error) {
      failure = messageOf(error);
    }
    this.#pending = false;
    this.#inFlight = undefined;

    if (failure !== undefined) {
      // The row stays and the error is on screen; a queued press is dropped rather than
      // retried against a write that just refused.
      this.#queuedAccept = false;
      this.#setStatus(failure, "error");
      return;
    }

    this.#outcome[kind].push(entry.lesson.id);
    this.#remove(entry);
    this.#setStatus(success, "success");

    if (this.#queuedAccept) {
      this.#queuedAccept = false;
      this.#accept();
    }
  }

  #remove(entry: ReviewEntry): void {
    const index = this.#entries.findIndex(candidate => candidate.lesson.id === entry.lesson.id);
    if (index === -1) return;

    this.#entries.splice(index, 1);
    // The decided row's neighbours keep their place: the next lesson moves up into its slot.
    const next = Math.min(index, this.#entries.length - 1);
    this.#list.setItems(this.#items());
    if (next >= 0) this.#list.setSelectedIndex(next);
    this.#selectedIndex = Math.max(0, next);
  }

  #setStatus(text: string, statusColor: StatusColor): void {
    this.#status = text;
    this.#statusColor = statusColor;
    this.requestRender();
  }

  /**
   * Closes the window. A decision still being written is waited for first: the outcome must
   * count it, and the caller's summary reads from the store the write is about to land in.
   */
  #finish(): void {
    // Leaving wins over a press that never started: the in-flight decision is waited for,
    // a queued one is discarded.
    this.#queuedAccept = false;
    const inFlight = this.#inFlight;
    if (inFlight === undefined) {
      this.done({ ...this.#outcome, quit: true });
      return;
    }
    void inFlight.then(() => this.done({ ...this.#outcome, quit: true }));
  }

  #renderBody(width: number): string[] {
    const lines: string[] = [];

    if (this.#entries.length === 0) {
      lines.push(muted(this.theme, "No undecided lessons left — every lesson has been decided."));
    } else {
      lines.push(...this.#list.render(width));
    }

    const entry = this.#denying ?? this.#current();
    if (entry !== undefined) lines.push("", ...this.#renderDetail(entry, width));
    if (this.#denying !== undefined) lines.push("", ...this.#reason.render(width));
    if (this.#status !== "") lines.push("", color(this.theme, this.#statusColor, this.#status));
    lines.push(
      "",
      muted(
        this.theme,
        this.#denying === undefined
          ? "↑/↓ or j/k move · a accept · d deny · q quit"
          : "Enter deny with this reason · Esc cancel",
      ),
    );

    return lines.map(line => truncateToWidth(line, width, Ellipsis.Omit));
  }

  #renderDetail(entry: ReviewEntry, width: number): string[] {
    const theme = this.theme;
    const lesson = entry.lesson;
    const inner = Math.max(1, width - 2);
    const lines: string[] = [
      bold(theme, color(theme, "accent", truncateToWidth(lesson.title, width, Ellipsis.Omit))),
      muted(theme, truncateToWidth(`${lesson.kind} · target: ${lesson.target}`, width, Ellipsis.Omit)),
    ];

    if (entry.context !== undefined) {
      lines.push(
        muted(theme, "overlap check:"),
        ...entry.context.split("\n").flatMap(line => wrapTextWithAnsi(line, width)),
      );
    }

    if (entry.blocked !== undefined) {
      lines.push(color(theme, "warning", truncateToWidth(`blocked: ${entry.blocked}`, width, Ellipsis.Omit)));
    }

    lines.push("", ...wrapTextWithAnsi(lesson.body, width));

    if (lesson.rationale.trim() !== "") {
      lines.push(
        "",
        muted(theme, "why keep it:"),
        ...wrapTextWithAnsi(lesson.rationale, width).map(line => color(theme, "dim", line)),
      );
    }

    if (lesson.citations.length > 0) {
      const quotes: string[] = [];
      for (const citation of lesson.citations) {
        quotes.push(...wrapTextWithAnsi(citation.citation, inner).map(line => `  ${line}`));
        quotes.push(...wrapTextWithAnsi(citation.excerpt, inner).map(line => color(theme, "dim", `  ${line}`)));
      }
      lines.push(
        "",
        muted(theme, `citations (${lesson.citations.length})`),
        ...capped(quotes, CITATION_LINES, hidden => muted(theme, `  … ${hidden} more citation lines`)),
      );
    }

    const preview = capped(
      entry.preview.split("\n").flatMap(line => wrapTextWithAnsi(line, width)),
      PREVIEW_LINES,
      hidden => muted(theme, `… ${hidden} more lines`),
    );
    lines.push("", muted(theme, "the write:"), ...preview.map(line => color(theme, "dim", line)));
    return lines;
  }
}

/**
 * Mounts the review window, or says why it cannot mount one. RPC stubs `ctx.ui.custom` (it
 * resolves `undefined` without ever calling the factory) and print/json have no UI, so guarding
 * on `hasUI` would let the one path that decides a lesson silently do nothing (ADR-0010).
 */
export async function runReview(
  ctx: ExtensionCommandContext,
  entries: ReviewEntry[],
  handlers: ReviewHandlers,
): Promise<ReviewOutcome | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/distill review needs the terminal: the review window is an interactive overlay.", "warning");
    return undefined;
  }

  return ctx.ui.custom<ReviewOutcome>(
    (tui: TUI, theme, _keybindings, done) =>
      new ReviewWindow(entries, theme as unknown as ReviewTheme, () => tui.requestRender(), done, handlers),
    { overlay: true },
  );
}
