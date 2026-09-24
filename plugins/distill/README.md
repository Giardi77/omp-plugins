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
/distill review    # decide the proposed lessons: ↑/↓ move, a accept, d deny, q quit
/distill disable   # pause without uninstalling
/distill purge     # forget this project's records (never omp's session files)
```

`/distill scan --limit 3` bounds a scan's cost, `/distill scan --dry-run` prints the exact payload
and calls no model, and `/distill scan --session <id>` evaluates one session without choosing.
Scans are serialized: two cannot run at once in one project.

A session whose whole bundle is larger than the evaluator's model can take is evaluated one trace
at a time — the parent first, then each subagent — so a 3 MB transcript still yields lessons instead
of a 400 error. Nothing is ever truncated: a single trace that still does not fit fails loudly,
names its size, and stays eligible for a retry. A run that fails reports what the provider said
(`the evaluator's model call failed: …`), and its dump under `tmp/` carries the same reason.

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

Approval writes into one of the project's own surfaces, always append-only and always editing what
exists before adding: `.omp/skills/<slug>/SKILL.md` (patched, or minted when the slug is new) and
`references/` beneath it, `.omp/rules/<name>.md` with its trigger in the frontmatter,
`.omp/agents/<name>.md`, or `.omp/APPEND_SYSTEM.md`. `RULES.md` and the session store are out of
scope by design; the review window shows the target file and the exact text first.

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
