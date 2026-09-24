# Activation is a project config file, and the plugin installs globally

Status: accepted

Distill installs once, globally: `omp plugin link` and non-marketplace installs ignore `--scope`
and write `~/.omp/plugins` regardless, and a global install is what makes the plugin usable in
every project without a per-project install step. Capture therefore cannot be scoped by
installation — a project is active only once `.omp/distill/config.yaml` exists, and `/distill setup`
is the only thing that creates it. `/distill enable` and `/distill disable` toggle the same
file's `enabled` key.

**Considered Options**: project-scope install as the predicate (rejected: only marketplace
installs honour `--scope project`, so it cannot be the guarantee); the harness's own per-project
keys (rejected: `extensions:` is a path list and `disabledExtensions` is a denylist — neither can
express opt-in, which is exactly what an un-activated project needs); capture-everywhere with
post-hoc filtering (rejected: that is the machine-wide behaviour that made the previous attempt
unusable).

**Consequences**: an un-opted-in project is untouched by construction. The activation predicate —
not the install scope — is the only thing protecting other projects during development. No
child-run marker is needed: evaluation runs in-process and its session is in-memory, so a scan
starts no second omp process and leaves nothing in the session store for a later scan to pick up.
