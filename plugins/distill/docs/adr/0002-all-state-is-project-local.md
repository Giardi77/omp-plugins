# All plugin state lives in the project

Status: accepted

The previous attempt at this job installed a machine-wide agent whose `install` and `repair`
paths reconfigured every detected harness and could not be kept scoped to one workspace; it was
removed for that reason. Distill writes only inside the project that activated it: its own tree
under `.omp/distill/` (tracked, except failure dumps under `.omp/distill/tmp/`, which are
gitignored), and approved knowledge into the existing `.omp/skills/` and `.omp/agents/` roots.
Traces are derived on demand and never persisted as files. Nothing is written to `$HOME`.

**Consequences**: one global input is read — omp's session store, which every session of every
project shares — but it is never written; only the project's own `.omp/` tree is. The evaluator
contributes nothing to that: its agent session is in-memory, so a scan leaves no record in the store
it reads. Knowledge never transfers between projects. That is deliberate — cross-project
recall was never requested, and a global store is what made the previous attempt unusable (a
machine-wide installer, a scope argument on every command, a collector to supervise). A second
project that wants the loop copies the evaluator prompt; there is no shared cache to corrupt.
