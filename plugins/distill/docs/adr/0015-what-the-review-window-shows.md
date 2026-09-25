# What the review window shows

Status: accepted

The review window grew out of the ledger's needs rather than the operator's: a list of lessons and a
paned detail of title, target, body, citations and the raw text of the write. The operator's words —
"it currently sucks" — and their ask were concrete: a recap, a git-diff-style view of *every* change
the evaluator wants to apply, and the session references behind it.

So the window is now, in reading order:

1. **A recap**, before anything is opened: how many lessons and of what kinds, every file the batch
   touches (with `(new)` for the ones it mints), and the lessons that cannot be written at all.
2. **The change, as a diff** — the file path, its mode (`new file` or `append`), and its lines: added
   ones marked `+`, context in dim, each with the file's own line number.
3. **Why it is worth keeping** — the `rationale`, which nothing else in the plugin renders (the
   surfaces only ever get title and body), and which is therefore the field the operator decides on.
4. **The evidence** — the cited record ids always, their verbatim excerpts behind `e`. The excerpt is
   the longest part of the pane and the least often needed; the ids are what say evidence exists.
5. `c` swaps all of that for **every change in the batch** on one scrollable screen, because the
   question "what is about to happen to my project" is sometimes asked about the batch rather than
   the lesson.

**Amended 2026-09-25**: the pane prints the lesson body only when there is no diff to read it in. A
blocked lesson renders no change at all, so its body is the one place its text can be read — and
`c`, which shows every change in the batch, covers the other corner where the preview is capped.
Every other write is already item 2 — for a mint the diff *is* the whole file — so the block was the
same text twice, and the operator asked for it gone: "this section is redundant, i can already see
it in the git-diff-like part of the TUI". The `rationale` is also no longer dimmed: it is the field the
decision turns on and the only place it is printed, so it reads at the terminal's own contrast with
just its heading muted. The excerpts under `e` keep their dim, where it marks a hierarchy between a
citation and its quote rather than making a decision harder to read.

Two decisions inside that are worth recording, because both are deliberate deviations:

- **There is no diff algorithm.** Every write this plugin makes is a `create`, an `append`, or a
  `splice` (a trim: the quoted lines out, the lesson's text where they were) — never a whole-file
  replace — so a change is a handful of lines out, a handful in, and the file's own neighbours as
  context, with line numbers from counting the file. `diff.ts` is forty lines of that, and
  a diff library would be a dependency answering a question nobody asked. The host ships a diff
  colorizer (`pi-tui/chrome/diff.ts`), and it is reachable only from the repo: from an installed
  plugin that subpath does not resolve, the same wall ADR-0011 recorded for two other host subpaths,
  which is why `thinking.ts` and `skill-rules.ts` are local mirrors. `diff.ts` mirrors the *look* —
  `+` in success, context dim, one number column — and owns no dependency.
- **The plans are recomputed after every decision.** Two lessons can append to the same file, and a
  detail pane computed when the window opened would show the second diff against the file as it was
  before the first was accepted — the diff the operator approves would not be the diff that lands.
  The window asks for a fresh plan after each accept or deny, so what is on screen is what is on
  disk plus what is about to be written.

The overlap check that used to sit in the pane — every skill, agent and rule in the project, listed
under each lesson — is gone: it was distill's own invention, it answered a question the evaluator
already answers when it chooses patch-versus-mint, and beside a diff it read as noise. The operator
said it should not exist, and it does not.

**Considered Options**: keep one lesson's raw write text as the pane (deleted: it shows the bytes
without the file they land in, which is the one thing an operator approving a write needs);
side-by-side diffs (rejected: wide, and a trim is a few lines among many — the column would be
mostly empty, and the reader would have to match rows by eye); a real diff library (rejected: nothing to compute); render the host's diff by importing
`pi-tui/chrome` (rejected: unreachable from an installed plugin, and a review window that silently
falls back to raw text in the marketplace layout would be worse than one that never promised it).

## The frame is a screenful, and the pane scrolls

The window was built as a component and tested as one: a frame as tall as its content, and the
operator's terminal is zoomed. The host mounts `ui.custom` overlays with
`{ anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 }`, and a bottom-anchored
overlay taller than the terminal is clipped by the engine from the **top** — so the recap and the
list, the two things that say what is being decided, were the parts that vanished. "The top text is
cut off" was never a rendering bug; it was a frame that did not fit.

Two changes, and they are really one:

- **The frame is exactly the terminal's height.** The body is given `rows - 2` and padded to it, so
  the border sits on the screen's edges and nothing can be clipped. The rows are shared out rather
  than guessed: the recap and the key hints hold theirs, the list shrinks first, and the detail pane
  takes what is left — with a floor below which the list is the better use of a small screen. The
  old fixed `RESERVED_LINES = 16` was a guess at a number the terminal knows.
- **What does not fit scrolls inside the pane.** `PgUp`/`PgDn` move it a page at a time; the last row of the pane says how much is above and
  below, and the offset resets when the selection changes, because the next lesson's detail starts
  at its own top. The list keeps ↑/↓ and j/k: paging a list of titles is not a move anyone needs,
  and the pane is the thing that does not fit.

The window also mounts `fullscreen: true` — the alt-screen idiom, the way the host's own dashboard
does. The frame covers the screen either way, but on the normal buffer the modal lives only in the
viewport: scrolling the terminal up shows the transcript and no window at all, which is the other
half of what the operator was looking at. On the alternate screen nothing sits behind it and there
is no scrollback to scroll into. Supplying `overlayOptions` replaces the host's defaults wholesale,
so the width, height and margin are restated alongside it.

One more thing came out of the operator using it: "i can't select stuff". `fullscreen: true` turns
mouse reporting on, which is what makes the wheel possible — and what stops the terminal from
selecting text, because every press and drag arrives as an escape sequence instead. The window also
swallowed those reports, so a click did nothing at all. Reporting is now off (`mouseTracking:
false`), which gives the pointer back to the terminal: drag-to-select works, and copying a path or a
lesson out of the review is one gesture again. The pane's scroll is a key, `PgUp`/`PgDn`, precisely
so the pointer never has to mean two things. A click-to-pick row would need reporting back on, and
with it the terminal's own selection gone — a trade the operator can ask for, but not one to make
for them.

**Considered Options**: cap the pane and say where the rest is (what the first attempt did — it fits
the screen but the lesson, its reason and its evidence are exactly what the operator is deciding on,
so dropping them is not a fix); make the whole body one scrollable column (rejected: then the list
scrolls away from the selection keys, and `a`/`d` act on a row that is no longer on screen); ask the
host for the height through `OverlayOptions.visible(termWidth, termHeight)` (rejected: it is a
visibility predicate, not a size channel — `process.stdout.rows` is the same terminal number, and it
is what the tests already seam).
