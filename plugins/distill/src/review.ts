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
import { describeChange, renderFileChange, type FileChange } from "./diff";
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
  /** What the approval does to the project, file by file. Empty when the lesson is blocked. */
  changes?: FileChange[];
  /** Set when the lesson cannot be written as it stands (missing target, bad slug, size cap, ...). */
  blocked?: string;
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
  /**
   * Re-reads what a lesson would change. Called after every decision, because accepting one lesson
   * moves the file another lesson appends to: the diff the operator approves has to be the diff that
   * lands, not the one computed when the window opened.
   */
  replan?(lesson: StoredLesson): Promise<FileChange[]>;
}

/** `Theme` from pi-tui, narrowed to what the window paints with. */
export interface ReviewTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

type StatusColor = "muted" | "success" | "error" | "warning";

/** Below this many rows the detail pane is not worth its lines: the list and the keys matter more. */
const DETAIL_MIN_LINES = 4;
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

/** Pad `lines` with blanks to exactly `height` rows. */
function fill(lines: string[], height: number): string[] {
  return [...lines, ...Array.from({ length: Math.max(0, height - lines.length) }, () => "")];
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
  #closed = false;
  #status = "";
  #statusColor: StatusColor = "muted";
  /** The evidence toggle: record ids always show, the excerpts are one key away. */
  #showEvidence = false;
  /** The whole-batch view: every lesson's changes, one screen, scrolled freely. */
  #showChangeset = false;
  #changesetOffset = 0;
  #changesetPage = 1;
  /** How far into the selected lesson's detail the pane is scrolled, and how much a page is. */
  #detailOffset = 0;
  #detailPage = 1;
  /** The list's row budget as last rendered, so the height is recomputed only when it changes. */
  #listRows = 0;
  #outcome: ReviewOutcome = { accepted: [], denied: [], quit: false };

  constructor(
    entries: ReviewEntry[],
    private readonly theme: ReviewTheme,
    private readonly requestRender: () => void,
    private readonly done: (outcome: ReviewOutcome) => void,
    private readonly handlers: ReviewHandlers,
    private readonly options?: { rows?: number | (() => number) },
  ) {
    // Undecided lessons only: a decided lesson is never listed, let alone decided twice.
    this.#entries = entries.filter(entry => entry.lesson.state === "proposed");
    this.#panel = new OverlayPanel("Distill review");
    // No search (the rows are acted on by key, not filtered) and no wrap-around: a stray arrow
    // must never point `a` at the first lesson after the last one. The row budget is not decided
    // here: it comes from the terminal's height, which is known on every render and can change.
    this.#list = new SelectList(this.#items(), 1, selectListTheme(theme), {
      search: "never",
      wrapNavigation: false,
    });
    this.#list.onSelectionChange = item => {
      const index = this.#entries.findIndex(entry => entry.lesson.id === item.value);
      if (index !== -1) this.#selectedIndex = index;
      this.#detailOffset = 0;
      this.requestRender();
    };
    this.#reason.prompt = "reason: ";
    this.#reason.onSubmit = value => this.#confirmDeny(value);
    this.#panel.addChild({ render: (width: number) => this.#renderBody(width) });
  }

  invalidate(): void {
    // Rendering is derived from the entries and the current selection.
  }

  /** The lessons still awaiting a decision, in the order the list shows them. */
  get undecided(): string[] {
    return this.#entries.map(entry => entry.lesson.id);
  }

  render(width: number): readonly string[] {
    return this.#panel.render(width);
  }

  handleInput(data: string): void {
    if (this.#showChangeset) {
      const escape = matchesKey(data, "escape") || matchesKey(data, "esc") || matchesKey(data, "ctrl+c") || data === "c" || data === "q";
      if (escape) {
        this.#showChangeset = false;
        this.#changesetOffset = 0;
        this.requestRender();
        return;
      }
      if (data === "j" || matchesKey(data, "down")) this.#changesetOffset += 1;
      else if (data === "k" || matchesKey(data, "up")) this.#changesetOffset = Math.max(0, this.#changesetOffset - 1);
      else if (matchesKey(data, "pageDown")) this.#changesetOffset += this.#changesetPage;
      else if (matchesKey(data, "pageUp")) this.#changesetOffset = Math.max(0, this.#changesetOffset - this.#changesetPage);
      this.requestRender();
      return;
    }

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

    if (data === "e") {
      this.#showEvidence = !this.#showEvidence;
      this.#detailOffset = 0; // the pane's contents changed shape; the top is where reading starts
      this.requestRender();
      return;
    }

    if (data === "c") {
      this.#showChangeset = true;
      this.#changesetOffset = 0;
      this.requestRender();
      return;
    }

    // The detail pane scrolls one page at a time; the list keeps ↑/↓ (paging a list of titles is
    // not a move anyone needs, and the pane is the thing that does not fit).
    if (matchesKey(data, "pageDown")) {
      this.#scrollDetail(1);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.#scrollDetail(-1);
      return;
    }
    // The list owns ↑/↓; j/k are the same moves under the window's keys.
    if (data === "j") this.#list.handleInput("\x1b[B");
    else if (data === "k") this.#list.handleInput("\x1b[A");
    else this.#list.handleInput(data);
    this.requestRender();
  }

  /** One page of the detail pane, clamped to what is actually there. */
  #scrollDetail(direction: -1 | 1): void {
    this.#detailOffset = Math.max(0, this.#detailOffset + direction * Math.max(1, this.#detailPage - 1));
    this.requestRender();
  }

  #rows(): number {
    const declared = this.options?.rows;
    const rows = (typeof declared === "function" ? declared() : declared) ?? process.stdout.rows ?? 0;
    return rows > 0 ? rows : 24;
  }

  /**
   * The rows the body may use: the panel's own border is painted outside them. The floor is 1, not
   * a comfortable number: the frame landing on the terminal's edges is what keeps the recap and the
   * list on screen, and on a screen too short for both, cutting the hints is better than the engine
   * cutting the top.
   */
  #budget(): number {
    return Math.max(1, this.#rows() - 2);
  }

  /**
   * Exactly `budget` rows, so the border lands on the terminal's edges. The overlay is anchored to
   * the bottom, so anything taller than the screen loses its *top* — the recap and the list, which
   * is what "the top text is cut off" was. Nothing is allowed to be taller.
   */
  #frame(lines: string[], width: number, budget: number): string[] {
    const fitted = lines.length > budget ? lines.slice(0, budget) : lines;
    const padded = [...fitted, ...Array.from({ length: Math.max(0, budget - fitted.length) }, () => "")];
    return padded.map(line => truncateToWidth(line, width, Ellipsis.Omit));
  }

  #current(): ReviewEntry | undefined {
    return this.#entries[this.#selectedIndex];
  }

  #items(): SelectItem[] {
    return this.#entries.map(entry => ({
      value: entry.lesson.id,
      label: entry.lesson.title,
      // The row is the lesson's title and nothing else: the kind and the target are in the detail
      // pane, and a row that spends its width on them cannot show the title.
      description: entry.blocked === undefined ? "" : "blocked",
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
    await this.#replan();
    this.#setStatus(success, "success");

    // Nothing left to decide: the window's job is done, so it closes rather than waiting for `q`
    // over an empty list. A failed decision returned above with its row still in place.
    if (this.#entries.length === 0) {
      this.#close(false);
      return;
    }

    if (this.#queuedAccept) {
      this.#queuedAccept = false;
      this.#accept();
    }
  }

  /** What the remaining lessons would change, against the files as they are after that decision. */
  async #replan(): Promise<void> {
    const replan = this.handlers.replan;
    if (replan === undefined) return;
    for (const candidate of this.#entries) {
      if (candidate.blocked !== undefined) continue;
      try {
        candidate.changes = await replan(candidate.lesson);
      } catch {
        // A plan that cannot be recomputed leaves the previous one on screen; the accept path fails
        // loudly on its own if the write itself is impossible.
      }
    }
  }

  #remove(entry: ReviewEntry): void {
    const index = this.#entries.findIndex(candidate => candidate.lesson.id === entry.lesson.id);
    if (index === -1) return;
    this.#detailOffset = 0;

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
    this.#close(true);
  }

  /**
   * The one exit. `quit` is false when the window closed because there was nothing left to decide —
   * a `q` pressed in that same tick has nothing to close, and `done` is called once either way.
   */
  #close(quit: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    // Leaving wins over a press that never started: the in-flight decision is waited for,
    // a queued one is discarded.
    this.#queuedAccept = false;
    const inFlight = this.#inFlight;
    const outcome = { ...this.#outcome, quit };
    if (inFlight === undefined) {
      this.done(outcome);
      return;
    }
    void inFlight.then(() => this.done(outcome));
  }

  #renderBody(width: number): string[] {
    const budget = this.#budget();
    if (this.#showChangeset) return this.#renderChangeset(width, budget);

    const theme = this.theme;
    const recap = this.#recapLines(width);
    const entry = this.#denying ?? this.#current();
    const prompt = this.#denying === undefined ? [] : ["", ...this.#reason.render(width)];
    const status = this.#status === "" ? [] : ["", color(theme, this.#statusColor, this.#status)];
    const hints = [
      "",
      muted(
        theme,
        this.#denying === undefined
          ? "↑/↓ or j/k move · a accept · d deny · e evidence · c all changes · q quit"
          : "Enter deny with this reason · Esc cancel",
      ),
    ];
    const footer = [...prompt, ...status, ...hints];

    // The rows are shared out, not guessed: the recap and the footer are as long as they are, the
    // list shrinks first, and the detail pane takes what is left — down to the floor below which
    // the list is the better use of the screen. The pane scrolls rather than being dropped: the
    // lesson, why it is kept and the evidence are the thing being decided.
    const room = Math.max(1, budget - recap.length - footer.length - 1 /* the blank before the pane */);
    const listRows = Math.max(1, Math.min(this.#entries.length, room - DETAIL_MIN_LINES));
    if (listRows !== this.#listRows) {
      this.#list.setMaxVisible(listRows);
      this.#listRows = listRows;
    }
    const list =
      this.#entries.length === 0
        ? [muted(theme, "No undecided lessons left — every lesson has been decided.")]
        : this.#list.render(width);

    const paneRows = room - list.length;
    const wanted = entry === undefined || paneRows < DETAIL_MIN_LINES;
    const detail = wanted ? [] : this.#renderDetail(entry, width);
    // The pane is padded to the rows it was given, so the hints and the status sit on the frame's
    // last rows instead of the blanks floating under them.
    const pane = wanted ? [] : fill(this.#windowDetail(detail, paneRows), paneRows);

    const lines = [...recap, ...list, ...(pane.length === 0 ? [] : ["", ...pane]), ...footer];
    return this.#frame(lines, width, budget);
  }

  /** The pane's slice of the lesson: what does not fit is a page away, not gone. */
  #windowDetail(detail: string[], height: number): string[] {
    const overflow = detail.length > height;
    const visible = overflow ? Math.max(1, height - 1) : height; // the last row is the note's
    const offset = Math.min(this.#detailOffset, Math.max(0, detail.length - visible));
    this.#detailOffset = offset;
    this.#detailPage = visible;

    const shown = detail.slice(offset, offset + visible);
    if (!overflow) return shown;

    const below = detail.length - offset - shown.length;
    const where =
      offset === 0 ? `${below} more line(s)` : below === 0 ? `${offset} above` : `${offset} above · ${below} below`;
    return [...shown, muted(this.theme, `… ${where} — PgUp/PgDn scrolls this pane`)];
  }

  /** What this batch is, before any of it is read: the count, the files, what cannot be written. */
  #recapLines(width: number): string[] {
    const theme = this.theme;
    const labels: Record<string, string> = {
      skill: "skill",
      skill_reference: "reference",
      rule: "rule",
      agent_prompt: "agent prompt",
      append_system: "append-system",
    };
    const counts = new Map<string, number>();
    for (const entry of this.#entries) counts.set(entry.lesson.kind, (counts.get(entry.lesson.kind) ?? 0) + 1);
    const byKind = [...counts.entries()].map(([kind, count]) => `${count} ${labels[kind] ?? kind}`).join(", ");

    const files = new Map<string, boolean>();
    for (const entry of this.#entries) {
      for (const change of entry.changes ?? []) files.set(change.path, change.mode === "create");
    }
    const named = [...files.entries()].map(([file, isNew]) => (isNew ? `${file} (new)` : file));
    const blocked = this.#entries.filter(entry => entry.blocked !== undefined);

    const lines = [
      bold(theme, color(theme, "accent", truncateToWidth(`${this.#entries.length} lesson(s) — ${byKind}`, width, Ellipsis.Omit))),
      // Wrapped, not clipped: a cut path is a path nobody can act on.
      ...(named.length === 0
        ? [muted(theme, "touches no files")]
        : wrapTextWithAnsi(`touches ${named.length} file(s): ${named.join(", ")}`, width).map(line => muted(theme, line))),
    ];
    for (const entry of blocked) {
      const warning = `blocked: ${entry.lesson.title} — ${entry.blocked ?? ""}`;
      lines.push(...wrapTextWithAnsi(warning, width).map(line => color(theme, "warning", line)));
    }
    return lines;
  }

  /** Every change in the batch, on one screen, in one order, scrolled freely. */
  #renderChangeset(width: number, budget: number): string[] {
    const theme = this.theme;
    const recap = this.#recapLines(width);
    const files = new Set<string>();
    for (const entry of this.#entries) for (const change of entry.changes ?? []) files.add(change.path);

    const body: string[] = [];
    for (const entry of this.#entries) {
      const changes = entry.changes ?? [];
      if (changes.length === 0) continue;
      if (body.length > 0) body.push("");
      body.push(bold(theme, color(theme, "accent", truncateToWidth(entry.lesson.title, width, Ellipsis.Omit))));
      // Nothing is capped here: this screen is the whole diff, and j/k is how it is read.
      for (const change of changes) body.push(...renderFileChange(change, this.#changeTheme(), width, { maxLines: Infinity }));
    }
    if (body.length === 0) body.push(muted(theme, "No changes: every lesson here is blocked."));

    const footer = muted(theme, `j/k or PgUp/PgDn scroll · ${files.size} file(s) · Esc or c back to the list`);
    // The same budget the list view lives by: the recap and the two blanks hold their rows, and
    // the diff takes every row that is left over.
    const height = Math.max(1, budget - recap.length - 2 - 1 /* the footer */ - 1 /* the "more" line */);
    const offset = Math.min(this.#changesetOffset, Math.max(0, body.length - height));
    this.#changesetOffset = offset;
    this.#changesetPage = height;
    const visible = fill(body.slice(offset, offset + height), height);
    const more = body.length - offset - visible.length;

    return this.#frame(
      [
        ...recap,
        "",
        ...visible,
        ...(more > 0 ? [muted(theme, `… ${more} more line(s)`)] : []),
        "",
        footer,
      ],
      width,
      budget,
    );
  }

  #changeTheme(): { added(text: string): string; removed(text: string): string; context(text: string): string; meta(text: string): string } {
    return {
      added: text => color(this.theme, "success", text),
      removed: text => color(this.theme, "error", text),
      context: text => color(this.theme, "dim", text),
      meta: text => muted(this.theme, text),
    };
  }

  #renderDetail(entry: ReviewEntry, width: number): string[] {
    const theme = this.theme;
    const lesson = entry.lesson;
    const inner = Math.max(1, width - 2);
    const lines: string[] = [
      bold(theme, color(theme, "accent", truncateToWidth(lesson.title, width, Ellipsis.Omit))),
      muted(theme, truncateToWidth(`${lesson.kind} · target: ${lesson.target}`, width, Ellipsis.Omit)),
    ];

    if (entry.blocked !== undefined) {
      lines.push(color(theme, "warning", truncateToWidth(`blocked: ${entry.blocked}`, width, Ellipsis.Omit)));
    } else if ((entry.changes?.length ?? 0) > 0) {
      // What will change, and where: the file's own lines, added ones marked.
      for (const change of entry.changes ?? []) {
        lines.push("", ...renderFileChange(change, this.#changeTheme(), width, { maxLines: PREVIEW_LINES }));
      }
      lines.push("", muted(theme, "c shows every change in this batch"));
    }

    // The body is printed only where the diff cannot speak: a blocked lesson renders no change at
    // all, so this is the one place its text can be read. Anything else is already above as added
    // lines — for a mint, the diff *is* the file — and printing it again was the same text twice.
    if (lesson.body.trim() !== "" && entry.blocked !== undefined) {
      lines.push("", muted(theme, "The lesson:"), ...wrapTextWithAnsi(lesson.body, width));
    }

    if (lesson.rationale.trim() !== "") {
      lines.push("", muted(theme, "Why keep it:"), ...wrapTextWithAnsi(lesson.rationale, width));
    }

    if (lesson.citations.length > 0) {
      const ids = lesson.citations.map(citation => citation.citation).join(", ");
      if (!this.#showEvidence) {
        lines.push(
          "",
          muted(theme, `evidence: ${truncateToWidth(ids, inner, Ellipsis.Omit)}`),
          muted(theme, `e shows what it says in the session (${lesson.citations.length} record(s))`),
        );
      } else {
        const quotes: string[] = [];
        for (const citation of lesson.citations) {
          quotes.push(...wrapTextWithAnsi(citation.citation, inner).map(line => `  ${line}`));
          quotes.push(...wrapTextWithAnsi(citation.excerpt, inner).map(line => color(theme, "dim", `  ${line}`)));
        }
        lines.push(
          "",
          muted(theme, `evidence (${lesson.citations.length}) — e hides it`),
          ...capped(quotes, CITATION_LINES, hidden => muted(theme, `  … ${hidden} more citation lines`)),
        );
      }
    }

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
      new ReviewWindow(
        entries,
        theme as unknown as ReviewTheme,
        () => tui.requestRender(),
        done,
        handlers,
        { rows: () => tui.terminal.rows },
      ),
    // The window's frame is a screenful, so it borrows the alternate screen the way `less` does:
    // nothing sits behind it, and the terminal's own scrollback cannot scroll the modal off the
    // viewport — which is what it looked like when the frame was taller than a zoomed terminal.
    // The host's defaults are restated because supplying options replaces them wholesale.
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        margin: 0,
        fullscreen: true,
        // The modal owns the screen, but the pointer belongs to the terminal: with mouse reporting
        // on, dragging selects nothing — every report is swallowed — and copying a path or a lesson
        // out of the window is the one thing an operator does with a mouse here. Scrolling is a key
        // (PgUp/PgDn) precisely so the pointer does not have to mean two things.
        mouseTracking: false,
      },
    },
  );
}
