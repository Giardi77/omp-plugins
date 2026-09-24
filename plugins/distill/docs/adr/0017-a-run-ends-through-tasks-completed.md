# A run ends through `tasks_completed`

Status: accepted

A run used to end when the evaluator stopped calling tools. That is the cheapest thing a model can
do — say nothing more — and it was indistinguishable from being finished: an evaluation that answered
after reading one section of a four-hundred-record trace looked exactly like one that had read the
whole session. Retirement reads execution (ADR-0008), so the silence retired the trace.

An evaluation now ends through `tasks_completed`, a third custom tool sealed beside the other two. It
refuses while any trace in the payload has not been read to its last record, and names the ones still
open; a run that settles without the call is a failure with reason `the evaluator finished without
calling tasks_completed`, and its traces stay eligible.

Three details decide how the gate behaves:

- **The test is the rendered section, not the request.** `get_trace`'s section reports the ordinals it
  actually showed, so the read that counts is the one whose last record is the trace's own last
  record. A request past the end renders nothing and proves nothing, and a range that stops one
  record short is not the end. The evaluator needs no new state to satisfy the gate: the inventory
  already prints `records 1..N` per trace.
- **`jq` never counts.** The filter reads the trace for its own benefit and returns what it kept; the
  tail it filtered away was never rendered. Reading it back is one call.
- **Neither does the transcript file.** The inventory hands the evaluator each trace's path and `read`
  can walk it, but a raw record carries no id for a citation to name (ADR-0013), and the gate reads
  the surface the run is judged on. One `get_trace` a section away, and the tail is what the payload
  already says it holds: `records 1..N`.
- **Per trace, not per run.** A session's bundle is the parent and every subagent (ADR-0006), so the
  parent's tail is a fraction of the evidence on a session with subagents. The gate is satisfied per
  trace, and a refusal names each trace still open with its record count.

**Considered Options**: leaving the end to silence and trusting the model to read everything —
rejected because the failure is invisible: a partial read that proposes a good lesson passes every
other check the plugin has, and the operator cannot tell it from a full one; ending the loop from
inside the tool with `session.abort()` — rejected because abort is the cancellation path (`/distill
purge`, D19), the one signal this plugin already uses to mean "the operator stopped it", and a run
that aborted itself would have to special-case its own signal to keep the recorded reason honest. The
SDK's own terminal-tool path is not open to a custom tool either: it is hardcoded to the built-in
`yield` (`#isTerminalYieldToolResult` in `agent-session.ts`, which aborts with
`TERMINAL_TOOL_RESULT_ABORT_REASON` after the call), and `AgentToolResult` carries no terminate flag.
Forcing the exit through `setForcedToolChoice` (`[forced, "none"]`) — rejected as a wrong-direction
fit, since it forces the *next* model call to a named tool, which for an exit means one more paid turn
whose only job is to call the tool the model just called; gating on the request (`from` near the end)
— rejected because asking for the tail and seeing it are different facts, and only the second is
evidence.

**Consequences**: `waitForIdle` stays — it is how the plugin waits for the host's stream to settle,
not the completion signal — and the deadline re-check now fires for any run that did not finish
through the tool rather than only for one that never answered, so a timed-out run still reports the
deadline. A run that finishes without ever calling `propose_lessons` keeps its older, more specific
reason. The gate is a floor and not a measure of attention: an evaluator that reads records 1..60 and
390..412 of a 400-record trace passes, and nothing here pretends otherwise. What it buys is that the
part of a trace a run skips is now a choice it made — and the refusal says so, in the one place the
model can still act on it.
