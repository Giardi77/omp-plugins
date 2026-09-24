# Distill

An OMP plugin that turns captured agent sessions into reviewed project knowledge.

## Language

**Project**:
The directory tree the plugin is active in, identified by its `.omp/` directory.
_Avoid_: repo, workspace, checkout

**Session store**:
omp's own transcript directory, `~/.omp/agent/sessions/` — one JSONL per session, read-only input
for distill.
_Avoid_: history, archive, logs

**Session**:
One omp agent run, interactive or headless, identified by omp's own session id and recorded in
the session store.
_Avoid_: conversation, thread, run

**Trace**:
The bounded, derived view of one session, or of one of its subagents, that distill works from.
_Avoid_: log, transcript, projection

**Event**:
Unused. The store's records are records; distill does not capture events.
_Avoid_: —

**Lesson**:
Something a trace teaches, and the unit that moves through the loop: proposed, then approved or
denied, then written into one of the project's own surfaces — a skill (or one of its references),
a rule, a subagent prompt, or `APPEND_SYSTEM.md`.
_Avoid_: candidate, insight, knowledge, memory

**Citation**:
A qualified record id — trace, then record — that a proposed lesson names as its evidence. The
evaluator emits citations, never quoted text.
_Avoid_: reference, link, excerpt

**Excerpt**:
The bounded quote distill extracts from a trace for each cited record; a lesson carries the excerpts
of everything it cites.
_Avoid_: citation, quote, snippet

**Approval**:
The human decision that turns a proposed lesson into an approved one.
_Avoid_: accept, merge, publish, tool approval

**Denial**:
The human decision that refuses a proposed lesson — the unqualified sense, and what `/distill deny`
means. The runtime's sense — a tool call refused by user policy or for want of an interactive UI,
visible in a trace as an error result — is always written *tool denial*.
_Avoid_: block, permission, refusal, rejection

**Review**:
The interactive act of deciding proposed lessons: `/distill review` opens a window over them, showing
the selected lesson's text, target and citations, and taking accept or deny. Accept writes at once;
there is no headless review.
_Avoid_: triage, inbox, queue

**Evaluator prompt**:
The project-owned file stating what makes a trace worth learning from: `.omp/distill/evaluator.md`,
handed to the evaluator as its system prompt.
_Avoid_: rubric, criteria, config

**Answer contract**:
The plugin-owned shape of the evaluator's answer: the schema and description of the `propose_lessons`
call that carries it, and the mechanical instructions that ride with them. Its version tracks that
schema alone, never the plugin's releases, and it is recorded in the ledger as provenance — like the
evaluator prompt's hash, and for the same reason: retirement reads execution, so nothing re-opens on a
version bump (ADR-0008).
_Avoid_: rubric, prompt, template, schema

**Payload**:
The bytes distill hands the evaluator for one evaluation: the session's traces — the parent's and its
subagents' — and nothing else.
_Avoid_: digest, prompt, projection

**Scan**:
The explicit, operator-triggered act that selects sessions and runs the evaluator over them, one
session at a time.
_Avoid_: batch, crawl, job

**Evaluation**:
One evaluator run over one session's traces, yielding zero or more proposed lessons.
_Avoid_: job, scoring, pass

**Evaluator**:
The sealed agent session that judges a trace against the evaluator prompt and proposes lessons. It
runs inside omp's own process rather than as a child process.
_Avoid_: judge, scorer, Jev
