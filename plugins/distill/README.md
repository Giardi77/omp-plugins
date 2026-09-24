# OMP Distill Extension

Turns the sessions omp already records into reviewed project knowledge.

Distill reads omp's own session store, derives a bounded trace of one session, asks a sealed
evaluator session to propose the lessons that session taught, and writes only what you approve
into the project's existing skills and subagent prompts. It captures nothing, spawns no child
process, and never writes to the session store.

## Install from the Giardi plugins marketplace

```bash
omp plugin marketplace add Giardi77/omp-plugins
omp plugin install omp-distill-extension@giardi-plugins
```

Restart OMP after installing so the extension is loaded.

For a local checkout: `omp plugin link /path/to/omp-plugins/plugins/distill`, then restart OMP.

## Activate a project

Distill installs globally and loads in every session, so it does nothing anywhere until a project
opts in by file:

```text
/distill setup
```

That writes `.omp/distill/config.yaml`, a default `.omp/distill/evaluator.md`, `.omp/distill/lessons/`
and a `tmp/` ignore rule. Then:

```text
/distill status    # is the loop on, how many sessions are eligible, what awaits review
/distill scan      # evaluate sessions — the terminal offers the project's sessions to choose from
/distill cancel    # stop a running scan
/distill review    # decide the proposed lessons: a recap, each change as a diff, the evidence on e
                   # ↑/↓ or j/k move · a accept · d deny · e evidence · c all changes · PgUp/PgDn scroll · q quit
/distill disable   # pause without uninstalling
/distill purge     # forget this project's records (never omp's session files)
```

`/distill scan --limit 3` bounds a scan's cost, `/distill scan --dry-run` prints the exact payload
and calls no model, and `/distill scan --session <id>` evaluates one session without choosing.
Scans are serialized: two cannot run at once in one project.

A scan runs in the **background** — the host's own daemon broker starts it detached, so closing OMP
does not end it, and `omp ps` lists it beside everything else the host supervises. `/distill status`
is where its state is read: which session it is on, how many lessons it has proposed, or what it came
to if it is over. A scan whose process died reads as *interrupted*, with the sessions it never
reached still eligible; `/distill cancel` stops a running one, gracefully first and by force only if
the runner will not go. When no daemon can be started (no `omp` on `PATH`, or a host that does not
serve the broker) the scan runs in the session that asked for it, and `status` says so.

The evaluator is handed an **inventory** of the session's traces — each one's id, record range, size
and transcript file — and reads the records itself with `get_trace`: a section at a time, by range, by
pattern, or with a `jq` query over that trace's records. Sections render prompts, assistant text and
tool calls in full (capped per record) and tool results as their first line plus size; cited evidence
is still extracted verbatim from the full record.

One session is one evaluation: the parent trace and its subagents in a single run. Nothing is ever
truncated — a payload the model refuses fails loudly, reports what the provider said
(`the evaluator's model call failed: …`), and leaves its traces eligible for a retry, with a dump
under `tmp/` carrying the same reason.

## What lives where

The default `evaluator.md` ships as [`templates/evaluator.md`](templates/evaluator.md) in this
package; setup copies it once and never overwrites it.

```text
.omp/distill/
  config.yaml        # activation predicate + settings (enabled, model, thinking, include_thinking, timeout_seconds, scan_limit)
  evaluator.md       # the project's own evaluator prompt — what makes a session worth learning from
  lessons/<id>.json  # proposed and approved lessons with the verbatim excerpts they cite
  decisions.jsonl    # append-only evaluation and decision ledger
  tmp/               # gitignored: failure dumps
  .locks/            # gitignored: advisory lock anchors
```

Approval writes into one of the project's own surfaces, editing what exists before adding anything —
and a lesson may take lines *out* (`removes`), which is how a skill or prompt that has grown past
what it earns gets trimmed rather than added to: `.omp/skills/<slug>/SKILL.md` (patched, or minted when the slug is new) and
`references/` beneath it, `.omp/rules/<name>.md` with its trigger in the frontmatter,
`.omp/agents/<name>.md`, or `.omp/APPEND_SYSTEM.md`. `RULES.md` and the session store are out of
scope by design. The review window opens with a recap of the batch — how many lessons, which files —
then shows each lesson as a diff of the file it writes (a new file, an append with the file's own
tail as context, or a trim with the lines going out marked), why it is worth keeping, and the cited
records behind `e`; `c` shows every change in the batch at once. The window is a screenful — the
border sits on the terminal's edges, so nothing is clipped — and the detail pane scrolls a page at a
time with `PgUp`/`PgDn` or the wheel when a lesson is longer than the room left for it. It borrows
the alternate screen while it is open, so the terminal's own scrollback cannot move it.

## What leaves the machine

An evaluation sends the session's traces — the parent session and its subagents — to your model
provider, plus whatever the evaluator reads from the project with its `read`, `glob` and `grep`
tools. Unmasked, by design: there is no redaction key, and `/distill scan --dry-run` prints the
exact payload so you can see what would leave before it does.

The evaluator runs inside omp's own process as a sealed agent session: an explicit tool list,
extension discovery, MCP, LSP and IRC off, an in-memory session so a scan leaves no record in the
store it reads, and an assertion on the mounted tool surface before any payload is sent.

The evaluator's tool surface needs omp's SDK at 17.4.0 or newer; older hosts are refused rather
than run unsealed.

## Verify

```bash
cd plugins/distill && bun install && bun run check && bun test
```

The real model call is not covered by tests: `/distill scan --dry-run` prints the payload without
calling one, and a live scan costs a model call per session.

Unit tests cannot see whether a real host loads the extension at all, so check that once per host
upgrade: `omp -p --no-session "/distill"` in a scratch project must print the usage text, not a model
answer. A load failure — a host package subpath that cannot be served, say — is logged with its path
and reason in `~/.omp/logs/omp.<date>.<pid>.log` (ADR-0011).
