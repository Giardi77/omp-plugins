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

Two decisions inside that are worth recording, because both are deliberate deviations:

- **There is no diff algorithm.** Every write this plugin makes is a `create` or an `append` — never
  a replace, never an in-place insert — so a change is entirely added lines plus the file's own tail
  as context, and its line numbers come from counting the file. `diff.ts` is forty lines of that, and
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

**Considered Options**: keep one lesson's raw write text as the pane (deleted: it shows the bytes
without the file they land in, which is the one thing an operator approving a write needs);
side-by-side diffs (rejected: wide, and nothing is ever removed here, so the left column would be
blank); a real diff library (rejected: nothing to compute); render the host's diff by importing
`pi-tui/chrome` (rejected: unreachable from an installed plugin, and a review window that silently
falls back to raw text in the marketplace layout would be worse than one that never promised it).
