# Evaluation sends the full trace

Status: accepted

The evaluator receives the complete trace rather than a redacted projection, and — because it can read
the project's own skills to judge a patch against them — also whatever it chooses to open in the
project, through the built-in `read`, `glob` and `grep` (ADR-0009). The tool is local-first, the model is the user's
own authenticated account, and an evaluator prompt that cannot read what was actually said cannot judge whether a
correction is worth reusing — the judgement the whole loop depends on. Nothing is masked on the way
out (see the amendment below).

**Consequences**: the model provider sees whatever the session saw, **plus** anything the evaluator
chooses to read from the project — the whole tree, source files, config and `.env` included, since
ADR-0009 withdrew the read bound this ADR first recorded. Accepted deliberately, and recorded here
rather than left implicit.

**Amended 2026-09-24**: the redaction key this ADR first kept as one-config-key egress control is
withdrawn by the operator's direction — full traces always, no masking knob, and no redaction
question at setup. One less setting that could disagree with what actually left. The dry run is the
disclosure instead: `/distill scan --dry-run` prints the exact payload and calls nothing.
