# Distill — session learning for OMP

Grilling record for `plugins/distill/` (package `omp-distill-extension`). The evaluator round closed
2026-09-23, and a second round the same day closed its tool surface and its prompt; the implementation
spec is issue #1 on the tracker. **No code yet.**

Every version, flag, option and failure mode this design rests on — measured, not assumed — lives in
[`evaluator-facts.md`](./evaluator-facts.md) beside this file. Decisions live in `docs/adr/`.

## What it is

An OMP plugin that reads the session transcripts omp already writes, turns a chosen session into a
bounded **trace**, proposes **lessons** from it under a prompt the project owns, and writes only
approved lessons into the project's existing skill and subagent surfaces. It captures nothing itself,
and it now spawns nothing either.

## Settled decisions

| # | Decision | Recorded in |
| - | -------- | ----------- |
| D1 | Self-contained: reader, evaluator and writer all live here. No external binary and no child process. | ADR-0007 |
| D2 | omp's session store is the only source; distill captures no events. | ADR-0006 |
| D3 | A trace is derived on demand and never persisted raw. | this spec |
| D4 | Everything distill writes is project-local under `.omp/distill/`; the session store is read-only input. | ADR-0002 |
| D5 | Evaluation is a sealed **in-process** agent session built from `pi.pi.createAgentSession`. | ADR-0007 |
| D6 | Approval patches an existing skill by default and mints a slug only when nothing matches; `.omp/agents/*.md` is also a target; `APPEND_SYSTEM.md` and `RULES.md` are out of scope. | ADR-0003 |
| D7 | Review through `/distill` commands; one notice at session start when unreviewed lessons exist; no background evaluation; **scans are serialized, one at a time**. | this spec |
| D8 | Name `distill`; the monorepo SDK pin rises to 17.4.0; declared features `read` and `learn`. | root ADR-0001 |
| D9 | Globally installable; a project is active only once `.omp/distill/config.yaml` exists. | ADR-0004 |
| D10 | Evaluation sends the full trace unmasked by default, plus anything the evaluator reads from the project; a redaction key exists and the published plugin asks at setup. | ADR-0005 |
| D11 | Commands: `setup`, `enable`, `disable`, `status`, `scan`, `review`, `purge`. | this spec |
| D12 | An approved lesson carries the bounded excerpts it cites; `purge` cancels an evaluation and deletes distill's copies, never omp's session files nor the files a lesson was already written into. | this spec |
| D13 | One evaluation per session by default: the parent trace and every subagent trace in one payload. | ADR-0007 |
| D14 | Outcome and eligibility are separate: `lessons` / `empty` (recorded as failed, reason `empty`) / `failed{reason}`; retirement reads execution, measured per trace. | ADR-0008 |
| D15 | The project's evaluator prompt is `.omp/distill/evaluator.md`; the plugin owns the answer contract, versioned by schema and never by release. | this spec |
| D16 | The evaluator holds `read`, `glob` and `grep` with the project as its cwd, plus one custom `propose_lessons`, and its answer is that call rather than parsed text. | ADR-0009 |
| D17 | A payload is the session's traces and nothing else; the evaluator finds knowledge with its own tools, and the tool's description tells it to consult the lessons store for a lesson that already denied the same proposal. | this spec |
| D18 | Setup writes a default `evaluator.md` and gates nothing, so the first scan covers whatever history exists; a completed evaluation still retires its trace. | this spec |
| D19 | `purge` is all-or-nothing behind a confirmation: cancel the run, then delete lessons, ledger and tmp — never omp's session files, and never the skills or agent prompts a lesson was already written into: purge deletes records, it does not unwrite files, and it names the files it left alone. | this spec |
| D20 | Citations are qualified ids printed in the render, since record ids are unique only within a file. | this spec |
| D21 | The ledger records which files each evaluation read, reconstructed from the evaluator's own transcript after the run, since built-in tools leave no other trail. | this spec |
| D22 | A tool-surface mismatch stops the scan before any payload and names the unexpected tools; nothing is written against a session. | ADR-0009 |
| D23 | Review is the `/distill review` window, built on `ctx.ui.custom` over the harness's public list components: the undecided lessons listed, the selected one's text, target and citations beneath, `↑/↓` to move, `a` accept, `d` deny, `q` quit. Accept writes immediately, after the window has shown the target and the exact text; deny takes an optional one-line reason; a decided row leaves the list and anything untouched stays proposed. | ADR-0010 |
| D24 | Review is terminal-only and has no commands: no approve/deny path for scripts or agents. Print mode has no UI at all and RPC has no `custom`, so `/distill review` says it needs the terminal rather than doing nothing. | ADR-0010 |

## Layout

```
.omp/distill/
  config.yaml        # activation predicate + settings (timeout 600, model, thinking, redact, …)
  .gitignore         # "tmp/" — written by setup so a failure dump can never be committed
  evaluator.md       # project-owned prompt
  lessons/<id>.json  # proposed and approved lessons, with cited excerpts
  decisions.jsonl    # append-only review and evaluation history
  tmp/               # failure dumps
```

## The evaluator, in one screen

Built from `pi.pi.createAgentSession` — never a direct import, which would resolve to the marketplace's
shared SDK copy (the pin's version, without `restrictToolNames` at all) rather than the host's. Sealed:
`restrictToolNames` with one exact list of four names — `read`, `glob`, `grep`, `propose_lessons` —
`allowRestrictedCustomTools`, `disableExtensionDiscovery`, MCP/LSP/IRC off,
`skills`/`rules`/`contextFiles`/`promptTemplates`/`slashCommands` emptied, `hasUI: false`,
`SessionManager.inMemory()`, a `parentTaskPrefix` so the session claims no process global, and the
host's `modelRegistry` so nothing is rediscovered. Its cwd is the project, which is what lets the
built-ins see `.omp/skills/` and `.omp/agents/` — and, since confinement was withdrawn deliberately
(ADR-0009), everything else too. The mounted surface is compared against that list through
`session.getEnabledToolNames()` before any payload is sent, because an option the host does not honour
fails silently. Prompt: the project's `evaluator.md` alone — the answer contract rides the
`propose_lessons` schema and description instead. Run: `prompt` → `waitForIdle`, bounded by a 600s
`deadline`; no retry, and no tool-call cap. The answer is the last `propose_lessons` call; its
citations are validated against the trace inside the tool, so a bad one returns as a tool error the
model can fix within the run, and the plugin extracts the excerpts itself. A session's payload is one
trace bundle; if it ever exceeds what the model accepts, it fails loudly and stays eligible
(split-by-trace is the recorded upgrade path).

## Non-goals for v1

- Our own event capture, and any write into the session store.
- Writing `APPEND_SYSTEM.md`, `RULES.md`, or any other prompt layer.
- Cross-project or user-global knowledge.
- Automatic, scheduled, or session-end evaluation.
- Splitting oversized payloads by trace (the upgrade path in ADR-0008).
- Beacon compatibility, or any dependency on an external binary.
- Marketplace polish beyond a valid package, a README, and a catalog entry.

## Verification

- **Fixtures**: a synthetic minimal session file in the observed shape, one per awkward case — a title
  record before the session header, a forked branch where only the active branch may be traced, a tool
  result carrying policy-denial text, an injected advisor message, a sibling subagent file, and one
  reasoning part to prove the opt-in key. A real session must never be committed.
- **`bun test` over the pure parts**: store reader (header scan, branch resolution, file selection,
  subagent pairing), trace builder, payload builder, answer-contract validation, citation resolution,
  excerpt extraction, eligibility, and the writer's name/description/size constraints through the
  imported helpers.
- **The evaluator boundary, split by risk**: sealed-session construction and the tool-surface
  comparison (no model call); the host-version gate; a submission whose citations do not resolve,
  returned as a tool error; a run that ends without ever calling `propose_lessons`; a timeout leaving
  the session usable.
- **The review window**: the component is tested the way `plugins/setup-skills/test/selector.test.ts`
  tests its selector — constructed against fixture lessons and a fake theme, its rendered rows and
  detail pane asserted, accept and deny driven through its callbacks (the writer call and the ledger
  row), and the mode guard that turns RPC and print into "needs the terminal".
- **The real model call**: excluded from CI, covered by the documented live check — `/distill scan
  --dry-run` prints the payload and calls nothing.
- **The silent-drop case**: a minted `SKILL.md` without a frontmatter `description` is not discovered,
  so the writer must refuse to produce one.

## The predecessor, and the one lesson from it

Beacon's loop is recorded in full in `evaluator-facts.md`. The finding worth keeping in view: it never
extracted lesson text at all — its model returned probabilities and its lesson bodies were the literal
string "no lesson text was extracted" — and its empty evaluations are indistinguishable in the data
from its merely low-scoring ones. Knowledge could vanish without a trace and nothing would say so.
Distill records a verdict for every evaluation, which is the whole reason `empty` is a recorded
outcome rather than a silent success.
