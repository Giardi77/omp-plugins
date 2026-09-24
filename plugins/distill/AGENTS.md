# AGENTS.md — omp-distill-extension

Turns recorded omp sessions into reviewed project knowledge. Domain language lives in
`CONTEXT.md`; decisions in `docs/adr/`; the grilling record and the measured fact sheet in
`.scratch/session-learning/`.

## Layout

- `src/config.ts` — the activation predicate (`.omp/distill/config.yaml`), settings, project-root
  discovery, the default evaluator prompt
- `src/store.ts` — read-only session store: per-project directories, header scan, active-branch
  resolution, subagent pairing
- `src/trace.ts` — the payload is an inventory of traces; `renderTraceSection` renders one bounded
  section of one of them (range or pattern), and `excerptFor` renders the cited record in full
- `src/jq.ts` — the `jq` runner behind `get_trace`: one argv element, NDJSON in, empty module path,
  capped output, killed on timeout
- `src/contract.ts` — the `propose_lessons` schema/description, answer validation, citation
  resolution, lesson identity
- `src/diff.ts` — what approving a lesson writes, as diff rows: a create or an append, with the
  file's own line numbers and tail — no diff algorithm, because nothing is ever replaced
- `src/job.ts` — a scan as a background daemon: the journal `/distill status` reads, the runner's
  entry point, and the host broker calls that start, list and stop it
- `src/bundle.ts` — one session's parent + subagent traces into one payload
- `src/evaluator.ts` — the sealed in-process evaluator session, its surface assertion, the run
- `src/lessons.ts` — lesson JSON + append-only ledger, eligibility, purge
- `src/writer.ts` — the only write path: skills (and their `references/`), rules, agent prompts,
  `APPEND_SYSTEM.md`
- `src/review.ts` — the terminal review window
- `src/commands.ts` / `src/index.ts` — the `/distill` command surface and the session-start notice
- `src/skill-rules.ts` — skill name/description/frontmatter rules and the size cap the loader
  imposes, mirrored from the host (ADR-0011)
- `src/thinking.ts` — the `--thinking` selectors `setup` offers and validates, mirrored from the
  host (ADR-0011)
- `src/util.ts` — the shared boundary helpers (`isRecord`, `messageOf`, `fileExists`)
- `templates/evaluator.md` — the default evaluator prompt setup copies into a project; taste only,
  and the file an operator then owns

## Rules

- omp's session store is read-only input, and distill captures no events (ADR-0006). Never write
  there, never add a hook that records anything.
- Evaluation sends the full trace, unmasked: there is no redaction key, and adding one back
  contradicts ADR-0005 as amended.
- The evaluator is built from `pi.pi.createAgentSession`, never a direct import of the SDK (the
  direct specifier resolves to the marketplace copy, not the running host). Sealing options are
  asserted through `getEnabledToolNames()` before any payload is sent, and the host version is
  gated at 17.4.0 (ADR-0007, ADR-0009).
- Nothing is written into the project's own surfaces except through an approval, and review is
  terminal-only (ADR-0003, ADR-0010): never add a headless approve/deny path. The surfaces and the
  kind vocabulary are ADR-0012's; `RULES.md` and the session store stay out of scope.
- A rule's frontmatter uses the host's own keys (`alwaysApply`, `globs`, `condition`, `astCondition`,
  `agents`) and a patch never rewrites them: a different trigger is a refusal, not a merge. Skill
  references are a file plus the line in `SKILL.md` that points at it.
- Retirement reads *execution*, not outcome (ADR-0008): only technical faults leave a trace
  eligible, and `purge` is the only re-opener.
- Lesson names, descriptions and file sizes go through `src/skill-rules.ts` — a description that
  sanitizes to empty is silently dropped by skill discovery, so the writer refuses it instead of
  reporting success.
- Runtime host imports are package roots only (`@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`,
  `@oh-my-pi/pi-coding-agent`): a compiled host resolves a subpath such as `@oh-my-pi/pi-utils/file-lock`
  to the npm copy in the Bun store and then fails the whole extension load on that copy's own imports,
  which registers no command and leaves `/distill` falling through to the model (ADR-0011). The
  managed-skill rules and the thinking selectors the host does not export live in `src/skill-rules.ts`
  and `src/thinking.ts`; keep each faithful to the host module named in its header.
- Keep the mechanical instructions in the `propose_lessons` description, never in the project's
  `evaluator.md` (D15): the file the operator edits must not go stale against the loop.
- The project-root walk-up and the YAML config round-trip are mirrored from `plugins/setup-skills`
  and `plugins/telegram` rather than shared: a marketplace plugin installs standalone, so a
  workspace-internal package would not travel with it. Keep the mirror faithful when either
  sibling changes.

## Verify

- `bun install && bun run check && bun test` (repo root)
- Extension load, in a real host: `omp -p --no-session "/distill"` in a scratch project must print the
  usage text in about a second. If the model answers instead, the extension failed to load — the path
  and error are in `~/.omp/logs/omp.<date>.<pid>.log`. `bun test` cannot catch this: under Bun the
  subpath imports resolve, only the compiled host can't serve them (ADR-0011).
- Live: `/distill setup` then `/distill scan --dry-run` in a scratch project; a real
  `/distill scan --limit 1` costs a model call, and the review window needs a terminal.
