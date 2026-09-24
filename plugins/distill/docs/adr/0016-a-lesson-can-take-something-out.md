# A lesson can take something out

Status: accepted

Every write the plugin made was a `create` or an `append`. That was deliberate — an approval should
never risk rewriting prose it did not write — but it left one kind of lesson impossible: the operator's
own observation that "if it steps in a bloated skill/prompt or whatever it can strip out stuff and
propose it as a lesson". A surface that has grown past what a session needs — the same rule twice, a
stale workaround, a wall of prose where a line would do — had nowhere to go but another paragraph on
top of it. Appending to bloat is how bloat grows.

So a lesson may carry `removes`: the lines to take out, quoted as the evaluator read them. The planner
finds those lines in the target file, refuses the lesson when it cannot (a technical fault: the traces
stay eligible and nothing is written), refuses it when the quote appears more than once, and plans a
**splice** — the quoted lines out, the lesson's body where they were, or nothing there when the body is
empty. The applier writes a temp file and renames it, so a crash cannot leave a half-trimmed surface,
which matters more here than for an append.

Two details are load-bearing:

- **Matching is whitespace-insensitive per line, and skips the blank lines inside a quoted block.**
  A lesson quoting a paragraph should not have to reproduce its indentation byte for byte, and a
  model asked to count blank lines is being asked the wrong question. The lines that come *out* are
  the file's own, so what the review shows removed is what gets removed.
- **One matcher, two readers.** `findRemoval` lives in the writer and is used by the diff too, so the
  preview and the write can never disagree about where the block is.

**Considered Options**: keep the append-only rule and let bloat be someone else's problem (rejected by
the operator, and by the fact that the plugin is the only thing reading these surfaces closely enough
to notice); let a lesson rewrite a whole file from its body (rejected: an approval would then carry the
authority to delete anything the model left out, which is a far bigger grant than a trim); a
diff/patch language in the lesson (rejected: unreadable in review and unreviewable in the ledger —
quoted lines plus a body is what an operator can check at a glance).
