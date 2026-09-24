# Evaluation runs as a headless child process

Status: superseded by ADR-0007 — the premise below is false, because the SDK is injected into extensions in full as `pi.pi`; the decision survives only as the rejected alternative, and the reasoning that actually keeps it rejected is recorded in ADR-0007

The OMP extension API exposes no way to run a model call — `ctx.models` is a read-only query
façade and `registerProvider` only *adds* providers — so anything that judges a session must
either be deterministic in-process or leave the process. We run `omp -p --no-tools --no-session`
as a child, with the project's evaluator prompt and a bounded projection on stdin, because it reuses the
user's authenticated models and keeps the criteria in a file the project owns rather than in
plugin code.

**Considered Options**: deterministic in-process heuristics (cheap and offline, but cannot judge
"is this correction worth reusing"); a built-in evaluator prompt (that is the behaviour being replaced);
no scoring at all (leaves the loop entirely manual).

**Consequences**: evaluation costs one model call per trace, so it is opt-in per run rather than
automatic; and a child `omp` looks exactly like a user session to our own capture, so the child
carries `OMP_DISTILL_CHILD=1` and every handler returns immediately when it is set.
