# The session store is the only source; distill captures nothing

Status: accepted

omp already persists a richer transcript than any hook adapter could assemble — prompts, assistant
text and thinking, tool calls with arguments, tool results with error flags, token and cost usage,
model and thinking-level changes — one JSONL per session under `~/.omp/agent/sessions/`, including
sessions that ran before this plugin existed and one file per subagent. Distill therefore installs
no event handlers for capture, keeps no event log of its own, and derives a bounded trace from the
store when a session is selected for evaluation.

**Considered Options**: live capture through the ten extension events (the Beacon design; rejected
as duplicated work for an omp-only tool, and it misses headless prompts because `input` fires only
for typed input); hybrid live-plus-store (rejected: two paths to keep in agreement for no signal
the store lacks, except approvals).

**Consequences**: history is free — every session already on disk is eligible — and a crashed
session still has a transcript, which live capture could not guarantee. In exchange distill
depends on a private format: the reader must scan for the `type:"session"` header rather than
assume line 1, select only top-level `<timestamp>_<sessionId>.jsonl` files, resolve the active
branch of the record tree rather than reading top to bottom, and fail soft when the header version
is one it does not know. Permission decisions are not persisted by omp — no entry type, no
built-in custom type, and the approval events are emitted only to subscribed extensions — so a
denial is read from the error result the runtime writes when a policy refuses a call, rather than
from a decision record. The trace's shape is
fixed in the spec: prompts, assistant text, tool calls and results, usage, model and
thinking-level changes, and injected `custom_message` records such as the advisor's; reasoning
parts sit behind a config key, and `developer` scaffolding plus debug payloads stay out.
