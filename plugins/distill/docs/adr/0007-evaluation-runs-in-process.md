# Evaluation runs in-process, in a sealed agent session

Status: accepted (supersedes ADR-0001)

Evaluation runs in the host process as a second agent session, built with
`pi.pi.createAgentSession()` — the SDK instance the host injects as `pi.pi`, never a direct import —
rather than as a child `omp` process. The session is sealed: `restrictToolNames` with an explicit
tool list, `disableExtensionDiscovery`, MCP/LSP/IRC off, an in-memory session manager, settings
loaded from the operator's own agent dir rather than the project's, and an
assertion on `session.getEnabledToolNames()` before any payload is sent. ADR-0001's premise — that the
extension API exposes no way to run a model call — was false: the SDK is injected in full as
`pi.pi`, and `createAgentSession` is the function omp's own in-process subagents already use.

**Considered Options**: keeping the headless child (ADR-0001) — rejected because `pi.exec` carries
neither `env` nor `stdin`, so the child needed a hand-rolled `Bun.spawn`, a temp cwd, a stdout
parser, exit-code classification and a child-run marker; and because reading the project's own skills
to judge a patch against them would have required giving the child the project as its cwd, discarding
the blind-cwd isolation the child design rested on.

**Consequences**: the price of in-process is *shared process globals* — `setActiveSkills`,
`setActiveRules`, `MCPManager.setInstance`, `AsyncJobManager.setInstance` and the session's agent
identity are all claimed by any session created without `parentTaskPrefix`, so the evaluator passes
one and is classified as a subagent — and with it set every one of those sites is guarded, so the
session claims **no** process singleton: the only process-level effects it can produce are idempotent
postmortem registrations and a `fetch.preconnect` warm-up. `sessionManager` must be `SessionManager.inMemory()`: the
default is a real session file in omp's store, which would make distill's own evaluation part of the
corpus it reads and eligible for a later scan — this replaces the child-era `OMP_DISTILL_CHILD`
exclusion rule with a structural guarantee. The tool surface is asserted after construction rather
than trusted, because a host that does not honour an option degrades **silently**: `toolNames: []`
means *every* built-in tool where `restrictToolNames` is unsupported, and an unhonoured
`allowRestrictedCustomTools` silently drops custom tools. In-process therefore requires the host's SDK
to be at least 17.4.0 — the first version carrying `restrictToolNames` and
`allowRestrictedCustomTools` — and the monorepo's pin tracks the host it must run under rather than
leading it.

Settings are the one input the sealed option list does not empty on its own: five options take an
explicit `[]` and a fixed `systemPrompt` replaces every generated block, but with `settings` omitted
the host resolves the **project's** own `.omp/settings.json` — enough for a project to attach an
advisor (`advisor.enabled`, fed its own `WATCHDOG.md`/`WATCHDOG.yml`), widen what the read tools may
open (`workspace.additionalDirectories`) and gate them (`tools.approval.*`). The evaluator therefore
loads its own settings through `Settings.loadReadOnly`, with the *agent dir* as its cwd: the
read-only path, so a scan neither opens the host's settings storage nor can write the operator's
config as a side effect, and the project layer on the walk-up is never read. `advisor.enabled` is
forced off on top, because the operator's own layer may enable it.

Three keys ride across from the host's live settings — `disabledProviders`, `enabledProviders`,
`disabledExtensions` — because every session creation calls the host's `initializeWithSettings`,
which repoints the process's capability settings at the instance it was handed and rebuilds those
three from it. A project-less instance would otherwise change what the **main** session sees on its
next capability load (a rule or extension reappearing after a scan), and those three gate what
exists rather than what a session is told. A host without `Settings.loadReadOnly` is refused with
that reason rather than failing the scan with a `TypeError`.

Verified on omp 18.3.0 against a project whose settings enable
an advisor: the evaluator reports `isAdvisorEnabled() === false`, and its composed system prompt is
byte-identical to the shipped `templates/evaluator.md` while a canary string placed in the project's
`AGENTS.md`, `.omp/APPEND_SYSTEM.md`, rules, skills, agents and `WATCHDOG.md`/`WATCHDOG.yml` appears
in none of it.

The session **must** be built from `pi.pi`, never from a direct
`import ... from "@oh-my-pi/pi-coding-agent"`. That specifier does not resolve to the host: an
installed plugin resolves it to the marketplace's shared copy under `~/.omp/plugins/node_modules`,
which is the *pin's* version (16.2.12 when this was written, 18.3.0 today) rather than the running binary's, and which
lags until the plugin is reinstalled. That copy has no `restrictToolNames` at all, so a direct import
silently produces an evaluator holding every built-in tool — `write`, `bash`, `edit` — inside the
operator's project. `pi.pi` is bound to the host's own module graph at load time and never lags it.
