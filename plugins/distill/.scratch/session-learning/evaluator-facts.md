# Distill — evaluator fact sheet

Facts gathered 2026-09-23 while grilling *how the evaluator works*. **No decisions here** —
decisions live in `docs/adr/`. Sources are cited so each claim can be re-checked.

## Versions — do not conflate

| | What | Where |
| - | ---- | ----- |
| Compile gate | `@oh-my-pi/pi-coding-agent@16.2.12` | pinned in `plugins/*/package.json`; installed per-plugin |
| Runtime | `omp/17.4.0` | `~/.bun/bin/omp`; `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` |

CLI facts below are read from the 17.4.0 source (the binary the child would actually invoke).
SDK/extension-API facts are read from the 16.2.12 types unless stated otherwise.

## CLI, print mode (read from 17.4.0 source)

- `-p`, `--no-tools`, `--no-session`, `--cwd`, `--model`, `--thinking` all exist. Also present and
  relevant: `--system-prompt`, `--append-system-prompt`, `--mode`, `--tools`, `--print-thoughts`
  (`src/cli/flag-tables.ts`; `src/cli/args.ts:247-270`).
- `-p` is **not required** when stdin is piped: non-TTY stdin auto-enables print mode
  (`src/main.ts:1285-1287`; `readPipedInput()` at `src/main.ts:186-204`).
- Prompt assembly: stdin is **prefixed** to the body, then `@file` text, then the first positional
  message (`src/cli/initial-message.ts`). stdin and a positional argument both work and combine.
- `--no-session` → `SessionManager.inMemory()` (`src/main.ts:786-788`). No JSONL, no breadcrumb:
  the session store stays clean.
- `--no-tools` → `options.toolNames = []`, which empty-filters `baseEntries`, so tool factories are
  never invoked (`src/main.ts:1141-1145`; `src/tools/index.ts:651-666`). The definitions are absent
  from the request, not merely withheld after construction.
- stdout in text mode carries **only assistant text parts** (plus `thinking` with
  `--print-thoughts`). Tool output and banners never go there; `Working...` and every error go to
  stderr (`src/modes/print-mode.ts`).
- `--mode json` exists: JSONL on stdout, session header first, then every `AgentSessionEvent`
  through `printableEvent()` (`src/modes/print-mode.ts:58,156`). `message_end` carries the full
  message, which includes `usage`.
- Exit codes: `1` for an unknown model (`process.exit(1)` on the explicit-model branch) and for
  "no models available"; also `1` when `stopReason` is error/aborted. Exit code alone cannot
  distinguish causes; stderr text can.
- Globally installed plugins **are** loaded in print mode — `loadSessionExtensions` runs before the
  mode branch, and `isInteractive` only gates the warp-event bridge. This is why
  `OMP_DISTILL_CHILD=1` exists.
- Without `--cwd`, a launch from `$HOME` auto-switches to `~/tmp`, `/tmp` or `/var/tmp`
  (`src/cli/startup-cwd.ts`). `--cwd` chdirs the process.

## Extension API (read from 16.2.12 types)

- `pi.exec(command, args, options?)` exists: `ExecOptions = { signal?, timeout?, cwd? }`,
  `ExecResult = { stdout, stderr, code, killed }` (`dist/types/exec/exec.d.ts`). It delegates to
  `execCommand` → `ptree.exec` (`src/exec/exec.ts`; wired at `src/extensibility/extensions/loader.ts:224`).
- **`ExecOptions` has no `env` and no `stdin`.** A child spawned through `pi.exec` can therefore be
  given neither the payload on stdin nor the `OMP_DISTILL_CHILD=1` marker.
- `withFileLock(filePath, fn, { staleMs?, retries?, retryDelayMs? })` exists at
  `dist/types/config/file-lock.d.ts`. It is **not** on `ctx`.
- `ctx.hasUI` is false in print/RPC mode. `ctx.cwd` is the project dir; `ctx.models` is a read-only
  query façade (`list`/`current`/`resolve`/`family`); `ctx.sessionManager` is read-only.
- `pi.pi` is `typeof PiCodingAgent` — the whole package index, described in the types as "Injected
  pi-coding-agent exports for accessing SDK utilities" (`dist/types/extensibility/extensions/types.d.ts:24,617`).
- That index re-exports `./sdk` (`dist/types/index.d.ts:24`), which exports
  `createAgentSession(options)` (`src/sdk.ts:1088`, no `@internal` marker). Its own doc example
  shows `sessionManager: SessionManager.inMemory()`, `systemPrompt: [...]`,
  `tools: codingTools({ cwd })`, `skills: []`.
- `CreateAgentSessionOptions` includes `cwd`, `agentDir`, `model`, `modelPattern`, `thinkingLevel`,
  `systemPrompt`, `customSystemPrompt`, `appendSystemPrompt`, `deadline` (absolute epoch ms),
  `customTools`, `extensions`, `disableExtensionDiscovery`.
- omp's own `task` tool runs subagents in-process through this same function
  (`src/task/executor.ts:2172`).

## Session records (from the live store)

- Every record after the two header records (`title`, `session`) carries `id` + `parentId`: 8
  lowercase hex, unique **within** a file, not across files.
- `toolCall` content parts carry a separate long provider-issued id; `toolResult` links back via
  `message.toolCallId` to that part id, never to the record id.
- Header records carry no ids.

## In-process evaluation (design B): reachable, blocked only by the pin

`createAgentSession` **is** reachable from an extension (`pi.pi`), so ADR-0001's premise — "the OMP
extension API exposes no way to run a model call" — does not hold at 16.2.12. The child process was
a choice, not a constraint.

At pin 16.2.12 the in-process route is blocked by a single missing option. Once the pin moves the
route opens: latest published is **18.2.11**, and `restrictToolNames` — the harness's own
stranger-session switch — is still declared and consumed there (`18.2.11 src/sdk.ts:575`, `:1761`).

- **The blocking option.** At 16.2.12 a tool-less session is not expressible: `createTools`
  collapses an empty list to undefined —
  `let requestedTools = toolNames && toolNames.length > 0 ? normalizeToolNames(toolNames) : undefined;`
  (`src/tools/index.ts:489`) — so `toolNames: []` means *every built-in tool*, and `restrictToolNames`
  is absent from 16.2.12 entirely (grep of `src/` and `dist/types/` both empty). It is present from
  at least 17.4.0 and still present in 18.2.11.
- **What `restrictToolNames: true` switches off** (17.4.0 evidence): built-in tool mounting
  (`tools/index.ts:696`, `mountBuiltinTools = requestedTools === undefined`), MCP (`sdk.ts:1836`),
  LSP (`sdk.ts:1604`, `enableLsp ?? !restrictToolNames`), IRC (`:1684`), extension discovery and
  extension-registered tools (`:2546-2611`), memory backend (`:2834`), auto-learn instructions
  (`:2852`), goal and plan mode (`:2648`, `:2748`), and the auto-injected read/write tools
  (`tools/index.ts:719,731`). It is a first-class stranger-session mode, not a trick.
- **The host version is readable at runtime.** `VERSION` is re-exported from the package index
  (`export { getAgentDir, logger, VERSION } from "@oh-my-pi/pi-utils"`), so a plugin can gate on
  `pi.pi.VERSION` and refuse to scan on a host older than the option it depends on.
- Silent failure is the residual hazard: a host older than the option ignores `restrictToolNames`
  and hands the evaluator an inert judge holding `write`/`bash`/`edit` inside the operator's project. The child's `--no-tools` cannot fail that way: an unrecognized flag is a
  hard error (`cli/args.ts`), and the planned flag-drift test asserts the flags still exist.
- **In-process is not cheap.** Constructing a session unconditionally does settings init,
  model-registry discovery plus a background refresh, a workspace-tree scan, and
  skill/template/slash-command discovery (17.4.0 `sdk.ts:1241-1320`), plus model-host preconnect
  (`sdk.ts:3973-4001`). MCP, LSP and the eval kernels *are* gated (`enableMCP`, `enableLsp`,
  `skipPythonPreflight`); the discovery is not.
- **Blindness is free for the child, explicit for in-process.** `--cwd <tmp>` is why the evaluator
  cannot see the project's skills — which, in the child design, was why the payload had to carry a
  skill inventory. An
  in-process session must be sealed by hand: `skills: []`, `contextFiles: []`,
  `disableExtensionDiscovery: true`, in-memory session manager. Drop one and the payload silently
  diverges from the one `--dry-run` printed. (Withdrawn: ADR-0009 puts the evaluator in the project
  with the built-in tools, so no inventory rides the payload at all.)
- **Teardown.** `session.dispose()` covers kernels, MCP, browser sessions and async jobs; LSP
  clients are process-global and shut down only via `beforeExit`/`postmortem`
  (`src/lsp/client.ts:1542-1600`), so an embedder cannot reliably close them.
- **If in-process is ever chosen**, build the session from `pi.pi.createAgentSession(...)` — the
  host's own injected SDK — never from a direct
  `import ... from "@oh-my-pi/pi-coding-agent"`. A direct import resolves to whatever copy the host
  maps, and a second SDK instance inside the live process would duplicate Settings, ModelRegistry
  and native init.

## Child-path plumbing (relevant only if the child survives)

`pi.exec(command, args, {signal, timeout, cwd})` carries **no `env` and no `stdin`**, so it cannot
deliver the payload or the `OMP_DISTILL_CHILD=1` marker. A child design therefore needs raw
`Bun.spawn`: stdin write, stream capture, kill-on-timeout, exit code. The SDK's `timeout` option is
not usable for it.

## Host and pin facts

- The `omp` binary is a compiled Mach-O at `~/.bun/bin/omp` (206 MB) and reports **17.4.0**; the
  global install `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` is 17.4.0, as is
  `@oh-my-pi/pi-utils`. npm's latest for the package is **18.2.11**. There is no separate `omp`
  npm package.
- The monorepo's convention is **compile-behind-runtime**: all three plugins pin 16.2.12 while the
  host runs 17.4.0. A pin newer than the host's SDK inverts that relationship — and
  `restrictToolNames` must exist in the *host's* copy, not merely in the types.
- `VERSION` is re-exported from the package index, so a host-version gate is a single property read.
- **An installed plugin does not resolve the host's SDK.** `~/.omp/plugins/` is the marketplace install
  root (`installed_plugins.json`, `omp-plugins.lock.json`, a shared `node_modules`), and
  `~/.omp/plugins/node_modules/@oh-my-pi/pi-coding-agent` is **16.2.12** — in which
  `restrictToolNames` appears **zero times** and `toolNames: []` collapses to `undefined`, meaning
  *every built-in tool*. So a direct `import "@oh-my-pi/pi-coding-agent"` inside an installed plugin
  builds objects from the pin's copy, not the 17.4.0 host's, and lags until reinstall. `pi.pi` is
  bound to the host's own module graph at load time; it is the only safe path, not a preference.

## Vocabulary collision: `learn`

`learn` is already harness vocabulary: a built-in tool that persists a lesson to long-term memory
(`src/tools/learn.ts:23,30`), a member of `MEMORY_BACKEND_TOOL_NAMES`
(`src/memory-backend/tool-names.ts:2`), and a feature name beside `manage_skill` (`src/sdk.ts:2977`).
A project directory named `.omp/learn/` would read as that tool's storage; `.omp/distill/` avoids it.

## Adjacent, parked, not part of this round

- The harness has its own project-level config keys: this repo's `.omp/config.yml` carries
  `extensions: [...]` (a path list — used here to load `./plugins/telegram`) and `skills.*`
  (`ignoredSkills`, `disabledExtensions`). A settings key `disabledExtensions` also exists
  (`config/settings-schema.ts:594`). Both are *denylists*; distill's activation predicate needs
  opt-in, so ADR-0004's premise is not obviously displaced — but the interaction deserves its own
  look before the predicate is frozen.
- `MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"]` — the harness accepts both spellings for
  its own project config.

## In-process sealing: verified recipe (17.4.0)

- Option surface: `customTools: (CustomTool | ToolDefinition)[]` (`sdk.ts:422`), `restrictToolNames`
  (`sdk.ts:502`), `allowRestrictedCustomTools` (`sdk.ts:508`), `deadline` (`sdk.ts:413`, absolute
  epoch ms — aborts the run via a TimeoutError DOMException merged into the signal, and leaves the
  session usable afterwards).
- **Omitting `allowRestrictedCustomTools` silently drops the custom tool** (`sdk.ts:2610-2613`).
  Third member of the silent-degradation family, after "empty `toolNames` means all tools" and
  "an unknown SDK option is ignored".
- Assertion handle: `session.getActiveToolNames()` (`agent-session.ts:4470`) and
  `getEnabledToolNames()` (`:4476`) — public, no `@internal`.
- Two in-repo precedents for exactly this shape:
  - `src/compress/session.ts:25-71` (`createCompressSession`) — the sealed template: two custom
    tools, `toolNames: ["rewrite","approve"]`, `restrictToolNames`, `allowRestrictedCustomTools`,
    `disableExtensionDiscovery`, MCP/LSP/IRC off, and skills/rules/contextFiles/promptTemplates/
    slashCommands emptied.
  - `src/security/coordinator.ts:43,240-255` — built-ins plus a custom tool under a restricted
    session: `["read","grep","glob","lsp","ast_grep","task","security_publish"]`.
- Per-agent tool surfaces are already a harness concept: `AgentDefinition.tools?: string[]`
  (`task/types.ts:363`) → `toolNames` (`task/executor.ts:2745-2752`) →
  `createAgentSession({ toolNames, restrictToolNames })` (`task/executor.ts:3079-3082`).
- **Version floor for the whole set: 17.4.0.** `restrictToolNames` and
  `allowRestrictedCustomTools` are both absent at 16.2.12, and both present at 17.4.0 and 18.2.11.

### Process-global hazards, and where the compress template is wrong for us

**`sessionManager` — a hard requirement, and the one place "copy compress verbatim" would ship a
bug.** `createAgentSession` defaults it to a real, file-backed session:
`SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))` (`sdk.ts:1343-1347`),
and `compress/session.ts` never passes it. An evaluator copied verbatim would therefore write a
session JSONL into `~/.omp/agent/sessions/<cwd-derived>/` on **every scan**, which breaks two settled
rules at once: distill's own run becomes part of the corpus it reads (its header carries the project
cwd, so a later scan would select it), and there is no `OMP_DISTILL_CHILD` marker in-process to
filter it out. Pass `SessionManager.inMemory()` (`session-manager.ts:2899`) explicitly. That also
retires the child-era exclusion rule entirely — with an in-memory session there is nothing to
exclude, which is a structural guarantee rather than a filter.

**`parentTaskPrefix` — insurance, not a correctness requirement.** Every process-global claim in
`createAgentSession` is gated on `!options.parentTaskPrefix`:

- `setActiveSkills(skills)` (`sdk.ts:1809-1810`) — the global is a module-level variable
  (`extensibility/skills.ts:49`). `SkillProtocolHandler.resolve` prefers a caller-supplied context
  (`internal-urls/skill-protocol.ts:52`), but `complete()` reads `getActiveSkills()` unconditionally
  and takes no bypass parameter (`:126-131`), so an empty snapshot does reach skill-name completion.
- `setActiveRules([...])` (`sdk.ts:1816-1819`) — the same shape for `rule://`; its resolver was not
  read, so treat it as the same shape rather than a measured result.
- `MCPManager.setInstance` (`:1925`), `AsyncJobManager.setInstance` (`:1820`), and
  `LocalProtocolHandler.setOverride` (`:1822-1824`, which additionally requires passing
  `localProtocolOptions`).
- Identity: `resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID`
  (`:1626`), and `agentKind` resolves to `"sub"` only when `taskDepth > 0` or `parentTaskPrefix` is
  set (`:1629`).

The harness has already been bitten by this class: the comment at `sdk.ts:1794-1798` cites issue
#1923 on secondary in-process top-level sessions mishandling async job routing. Every in-process
child in the harness sets the marker (`task/executor.ts:3114`,
`modes/controllers/tan-command-controller.ts:145`, `task/persisted-revive.ts:126`). Copy compress's
option set verbatim — including `hasUI: false`, `autoApprove: true`, and the explicit
`agentId`/`agentDisplayName`, which also keep the session from registering as Main — and add the
marker: compress is the only session in the `omp compress` process; ours is not.

### Two costs that are smaller than they looked

- `Settings.init` is a memoized process singleton (`config/settings.ts:425-426`), so the host has
  already paid it and our call returns the cached instance.
- `ctx.modelRegistry` is on `ExtensionContext` (`types.d.ts:315`), so passing
  `modelRegistry: ctx.modelRegistry` skips `discoverAuthStorage` and the background refresh. Pass
  only `modelRegistry`, never `authStorage` beside it — a guard throws unless both share one
  `authStorage` instance.

## Writer-phase constraints (verified 2026-09-23)

Recorded here because the evaluator's lesson text and descriptions are model-generated, and one of
them lands inside a system prompt.

- The project skill provider passes `requireDescription: true` (`discovery/builtin.ts:286-292`), and
  `scanSkillsFromDir` silently drops a SKILL.md whose frontmatter has no `description` —
  `if (requireDescription && !frontmatter.description) return;` (`discovery/helpers.ts:400-402`).
  A minted skill without frontmatter is invisible, with no error anywhere.
- `autolearn/managed-skills.ts` already solved this class, and its helpers are importable: the subpath
  `@oh-my-pi/pi-coding-agent/autolearn/managed-skills` exists at the pin (16.2.12) and resolves,
  because the package's `./*` wildcard maps to `./src/*.ts` for import and `./dist/types/*.d.ts` for
  types. Verified exports: `sanitizeSkillName`, `sanitizeManagedDescription`,
  `isValidManagedSkillName`, `MAX_MANAGED_SKILL_BYTES`, `toSkillFrontmatter`,
  `MANAGED_SKILLS_PROVIDER_ID`, plus `writeManagedSkill`/`deleteManagedSkill`/`getManagedSkillsDir`,
  which target `~/.omp/agent/managed-skills` and so are not reusable for a project skill root.
  - `sanitizeSkillName` (line 34) **throws** outside `^[a-z0-9][a-z0-9-]{0,63}$` — loud, not silent —
    and its comment names the reason: "a bad name can never escape `getManagedSkillsDir()`".
  - `sanitizeManagedDescription` (line 62) strips control/format characters, `<>` and backticks,
    collapses `~~~`, and is applied **on read as well as write** "so existing files are safe too". The
    description renders into the system prompt's `<skills>` listing, so it is a trust boundary.
  - `isValidManagedSkillName` (line 49) exists to validate names read from disk, because a
    hand-placed `SKILL.md` whose `frontmatter.name` did not come from `sanitizeSkillName` "must not
    render unescaped into the system prompt".
  - `MAX_MANAGED_SKILL_BYTES = 64_000` (line 20) is checked against the **final file's UTF-8 bytes**
    (body + description + frontmatter), not the body's length, and throws with the actual size.
  - Empty description and empty body also throw, and the empty-description error documents the
    silent-drop trap explicitly: an all-whitespace description sanitizes to `""`, discovery then drops
    the skill, "so the tool would report success for a skill that never appears".
  - The write path is hardened beyond content: it refuses a symlinked root, a symlinked skill
    directory, and any `SKILL.md` with `nlink > 1` ("refusing to overwrite a file that may be
    user-authored elsewhere"); creates with `O_CREAT|O_EXCL` ("wx") to close check-then-write races;
    re-checks the opened handle's stat before truncating so a path swap cannot redirect the write; and
    serializes mutations per skill name.
- Distill writes into the project's skill root rather than `getManagedSkillsDir()`, so the paths
  differ — the constraints and the safety posture do not.

## Beacon (the predecessor): how it records outcomes (verified 2026-09-23)

Upstream `Asymptote-Labs/agent-beacon` (Go, MIT) is public. The local install is Homebrew
`beacon 1.3.21` (`/opt/homebrew/bin/beacon`, keg at `/opt/homebrew/Cellar/beacon/1.3.21`), and its
evaluator **never ran on this machine**, so there are no local outcomes to sample.

**The local artifacts are not evaluation data.** `~/.beacon/endpoint/logs/runtime.jsonl` is 23 records
of `agent_runtime` telemetry (`session.started`, `prompt.submitted`, `tool.invoked`,
`command.executed`, `token.usage`, `session.ended`) with no lesson, score, evaluation or status field
anywhere; `~/.beacon/endpoint/traces.db` is a trace search index (`traces`, `trace_events`,
`trace_search`, `trace_index_state`). The learning store is a SQLite `memory.db` that does not exist
here, because the loop is a separate, explicitly-invoked CLI workflow (`beacon memory`). The spec's
"retired Beacon corpus" therefore has nothing to migrate even in principle.

**The loop, read from source** (`pkg/asymptoteobserve/learning.go`, `cli/beacon/internal/learning/*`,
`cli/beacon/cmd/memory.go`):

- **Outcome vocabulary**: evaluations are `dry_run | completed | failed`; candidates are
  `candidate | approved | rejected | superseded`. There is **no** `no_lessons`, `empty` or `skipped`.
- **The zero case is invisible**: a run that finds nothing is a plain `completed` row whose mean
  probability sits under `CandidateScoreThreshold = 0.60` (`internal/learning/candidate.go`),
  producing no candidate row. "Nothing worth learning" and "found something below the bar" are the
  same record, distinguishable only by score.
- **`failed` is the technical bucket** — transport and parse errors, carrying an `error` string, a
  different record shape from a clean run. Overloading it with empty runs costs the ability to tell a
  broken evaluator from a boring corpus.
- **No lesson text is ever extracted.** The model returns probabilities over three fixed questions
  (`RubricQuestions`, `questionsFromJevAnswers`); `candidateBody()` emits the literal string "no
  lesson text was extracted", so a promoted `SKILL.md` is a pointer to a trace plus three
  probabilities. The pipeline asks "is there a reusable lesson?" and never asks what it is.
  (Placeholder symptom is real: issue #620, patched by PR #630.)
- **Silent payload truncation**: `maxProjectionEvents = 80`, `maxProjectionText = 1200`.
- **Rejections are remembered but not honoured**: `rejected` + `review_reason` persist durably, but
  the idempotent upsert's `ON CONFLICT` clause deliberately omits `state`, so the same lesson is
  proposed again.
- **Selection is stateless**: every run re-queries the trace index (`ensureCurrent`/`reindexDB` over a
  size+mtime fingerprint) — no watermark, no per-session dedupe. Re-processing is suppressed only
  indirectly, by an idempotent evaluation id and by deterministic candidate ids whose state persists.
- **No lost-knowledge guards**: no retries, no re-scan queue, no empty-run metric, no alert. A failed
  evaluation is persisted with its error string and the command exits non-zero.
- Caps that do exist: per-run `--limit` (default 25) and the 0.60 score threshold.

## Submission tool, measured (2026-09-23)

What the answer-through-a-tool surface rests on. Host 17.4.0 source unless stated; the pin is
types-only, so nothing here is claimed for it.

- **Schema-failing arguments are a model-visible, retryable tool error — not a run failure.** The
  agent loop validates each call and, on throw, stores `validationErrorMessage`
  (`pi-agent-core/src/agent-loop.ts:2176-2190`); `emitToolResult` posts a `toolResult` carrying
  `isError: true` and the message (`:2449-2459`), which the model reads as an ordinary failed call and
  can correct in the same run. Only `YieldTool` escapes validation, through `lenientArgValidation`
  (`tools/yield.ts:272`).
- **A custom tool is dropped silently unless `allowRestrictedCustomTools: true` AND its name is listed
  in `toolNames`.** `sdkCustomTools` is `[]` whenever the flag is absent under `restrictToolNames`
  (`sdk.ts:2610-2613`), and `createTools` filters the requested names against the *built-in* registry
  only (`tools/index.ts:464-468`), so a custom name reaches the active set solely through the custom
  path.
- **`getEnabledToolNames()` is the honest assertion, not `getActiveToolNames()`.** The active list is
  `agent.state.tools.map(t => t.name)` (`session/session-tools.ts:351-354`); the enabled list appends
  `xd://`-mounted names (`:356-361`), which are callable through the `write` transport without ever
  appearing on the wire.
- **A restricted session's active set is exactly the requested list, intersected with the registry.**
  `alwaysInclude` is `[]` under `restrictToolNames` (`sdk.ts:3019-3026`), so registered tools never
  widen it, and `requestedActiveToolNames` filters `goal` out unconditionally (`:3030`).
- **Two documented exceptions widen a restricted list; neither applies to us.** `yield` is pushed when
  `requireYieldTool: true` (`sdk.ts:2956-2967`; `tools/index.ts:660-664`); the checkpoint/rewind pair is
  pushed when either is requested, a pairing that "applies to restricted sessions too"
  (`sdk.ts:2988-2999`). The `manage_skill`/`learn` mirror is gated on `!restrictToolNames`
  (`sdk.ts:2976-2984`), so it cannot widen ours.
- **Precedents for reading a run's product out of a tool call.** `security/publication.ts:295` hands the
  bundle to an `onPublished` callback, wired at `security/coordinator.ts:592-596`;
  `compress/protocol.ts:143-175` keeps drafts in a closure-owned ledger that `compress/index.ts:201-213`
  polls. The `task` executor's `extractedToolData` path is **not** reusable outside a subagent run —
  `subprocessToolRegistry` extraction is driven by `task/executor.ts:1378-1387`, not by a generic
  session.

## Review surface, measured (2026-09-23)

What the `/distill review` window rests on. Host 17.4.0 (`src/…` = `@oh-my-pi/pi-coding-agent`,
`pi-tui/src/…` = `@oh-my-pi/pi-tui`); the vendored upstream checkout in this repo is
`.reference/oh-my-pi/packages/coding-agent/`.

- **`ctx.ui` is a real extension surface** (`ExtensionContext.ui`, `hasUI: boolean`, `mode: "tui" |
  "rpc" | "json" | "print"` — `src/extensibility/extensions/types.ts:450-466`): `select(title,
  options)` (`:260-263`, returns the selected *label*), `confirm` (`:266`), `input` (`:269`), optional
  `askDialog?` (`:272-275`), plus `notify`, `editor`, `custom`, `setStatus`, `setWidget`, theme
  methods (`:278-350`).
- **Availability is per front-end, and only the TUI has everything.** Interactive mode implements the
  full object (`src/modes/controllers/extension-ui-controller.ts:104`). RPC implements `select`
  (`src/modes/rpc/rpc-mode.ts:741-757`), `confirm` (`:759-772`), `input` (`:774-788`) and `editor`, but
  **stubs `custom` (it resolves `undefined`) and declares no `askDialog`**. Print and json pass no UI
  context at all, so the runner keeps `noOpUIContext` (`src/extensibility/extensions/runner.ts:401-424`,
  `:611`, `:879-881`) — `select`→`undefined`, `confirm`→`false`, `input`→`undefined`, `notify` a no-op.
- **`ui.custom` is structural, not a host class.** `custom<T>((tui, theme, keybindings, done) =>
  ExtensionUiComponent | Promise<…>, options?)` (`src/extensibility/extensions/types.ts:303-310`),
  where `ExtensionUiComponent = Component & { dispose?(): void }` (`:227`) and `Component` comes from
  `@oh-my-pi/pi-tui` with exactly one required member: `render(width: number): readonly string[]`
  (`pi-tui/src/tui.ts:151,160`; `handleInput?(data: string)` at `:165`, `invalidate?` at `:177`).
  A duck-typed object literal satisfies it — the vendored example returns one
  (`.reference/oh-my-pi/packages/coding-agent/examples/extensions/tools.ts:113-124`). `done(result)`
  resolves the promise (`extension-ui-controller.ts:1101-1109`); `overlay: true` mounts it as an
  overlay instead of replacing the editor slot (`:1120-1134`).
- **List components are public**: `SelectList` and `SettingsList` are exported from the `@oh-my-pi/pi-tui`
  barrel (`pi-tui/src/index.ts`), which is what the vendored example uses.
- **Text constraints.** A `select` *title* may be multi-line — it is split on newlines, first line to
  the border, the rest as accent rows (`src/modes/components/hook-selector.ts`). Option *labels* are
  forced single-line (`sanitizeSingleLine`, `pi-tui/src/components/select-list.ts`), so a lesson's body
  cannot ride a list row.
- **Command registration**: `pi.registerCommand(name, { description?, getArgumentCompletions?, handler })`
  (`src/extensibility/extensions/types.ts:1333-1340`), handler `(args: string, ctx) => Promise<void>`
  (`:1162`) receiving the raw remainder after the first space (`src/session/agent-session.ts:5786-5788`).
- **Nothing confines the built-ins, measured.** The tree's only workspace-containment helper is
  `confineToWorkspace` (`src/tools/path-utils.ts:551`), and its single importer is the Cursor download
  path (`src/cursor.ts:34,818`) — `read`, `glob` and `grep` resolve paths with no root check, so a
  session with the project as its cwd reaches `.env`, and absolute paths reach anything the account can
  read. ADR-0009 records this as accepted, not overlooked.
- **In-repo precedent for the review window** (the closest thing to it already exists here):
  `plugins/setup-skills/src/selector.ts:202` mounts a `Component` through `ctx.ui.custom<T>((tui,
  theme, _keybindings, done) => new ProjectSkillsSelector(...), { overlay: true })`, re-rendering via
  `tui.requestRender()` (`:203`) and resolving `done(null)` on cancel (`:135`) or `done(new Set(...))`
  on commit (`:193`). Its command guards on `ctx.hasUI` first (`src/index.ts:87`), and
  `plugins/telegram/src/index.ts:249-254` does the same before `ctx.ui.input`. The component is tested
  by direct construction plus `render(width)` assertions — `plugins/setup-skills/test/selector.test.ts`.
