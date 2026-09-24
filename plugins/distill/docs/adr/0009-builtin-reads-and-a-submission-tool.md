# The evaluator reads with the built-in tools and answers through a submission tool

Status: accepted (supersedes ADR-0005's read-surface clause)

The evaluator holds `read`, `glob`, `grep` and one custom tool, `propose_lessons`, with the project as
its cwd — and its answer *is* the `propose_lessons` call, never JSON parsed out of the final assistant
message. The list is exact: sealed the way ADR-0007 requires, and compared against
`session.getEnabledToolNames()` before any payload is sent. An option the host does not honour fails
silently, and a custom tool that fails to mount would otherwise surface only as a run that never calls
it; the comparison costs one call, and a mismatch stops the scan and names the unexpected tools.

Reading is deliberately unconfined. The evaluator needs the project as its cwd to see `.omp/skills/`,
and the built-ins take absolute paths, so its reach is neither the knowledge roots nor even the
project: source, config, `.env` and anything else the process can open are readable, and everything it
reads joins its context at the model provider. That withdraws the read bound ADR-0005 first recorded.

**Considered Options**: a confined reader of our own, listing and reading under the knowledge roots —
rejected in favour of the tools the model already knows and the code we never write, with the loss of
confinement accepted on the record rather than suffered by omission; a text answer parsed from the
final message — rejected because a malformed answer costs a run that may already have spent its 600s
deadline, while a tool call's arguments are validated before the turn ends and a rejection returns as a
tool error the model can fix inside the same run; two submission fields, trace and record — rejected in
favour of one qualified id printed in the render, so the value the model reads is the value it cites.

**Consequences**: with built-ins, nothing intercepts file access, so the per-evaluation read log is not
obtainable from the tools — the evaluator's own transcript is the only place it could be
reconstructed. The mechanical instructions — call this tool once, cite records, consult the lessons
store for a lesson that already denied the same proposal — belong to the description of
`propose_lessons`, which leaves the project's `evaluator.md` holding taste alone. Citations are
qualified as `trace:record`, because record ids are unique within one session file and collide across
the traces a single payload bundles.
