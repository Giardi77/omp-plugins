# A scan is a background daemon

Status: accepted

`/distill scan` used to run inside the OMP that typed it: closing OMP killed the scan, and the model
call in flight was lost with it — the operator's question ("the scan will stop if I close omp right?")
was already the answer, and the honest one was that a scan is minutes of a model call and should not
be tied to a window. They asked for background daemon management.

The host already has it. `pi-coding-agent/src/launch/*` is a project-scoped broker that starts
detached children, journals them under `~/.omp/run/daemons/<project>/`, captures their output to
`output.log`, keeps them alive across the host's exit, restarts or stops them on request, and shows
them in `omp ps`. Extensions cannot reach it through a `ToolSession`, but
`createDaemonBrokerClient(projectDir)` needs nothing else, so a plugin can drive it directly.

So the scan is two halves. **`/distill scan`** resolves which sessions are eligible (that needs a
UI — the TUI's session picker), writes them as a journal (`tmp/scan.json`), and asks the broker to
start `omp -p "/distill _job"` detached; the command returns with the pid and nothing else. **The
runner** — the same `scanOne` the command used to call inline — takes the scan lock, walks the
journal, updates it after every session, and marks it finished, cancelled or failed. `/distill
status` reads the journal for progress and the broker for liveness; `/distill cancel` writes the
cancel request the runner already polls, and escalates to the broker's `stop` only when the runner
will not go.

**One runner per scan, and nothing resident.** There is no idle process, no IPC, no daemon of our
own to start, own, or shut down: a scan spawns a runner, the runner exits when its scan does, and the
broker's record for it is a process rather than a service. A resident supervisor would buy nothing —
scans are operator-initiated and minutes long — and would raise the one question this design does not
have: when two OMP instances want one.

Deliberate consequences:

- **OMP exiting no longer ends a scan.** Verified by killing the parent 400 ms after it handed off:
  the daemon finished the scan and the ledger recorded it.
- **A scan that dies unfinished reads as "interrupted"**, never as silence: the journal says where it
  got to, and everything it never covered stays eligible, so the next scan continues.
- **The runner's notices go to the broker's `output.log`**, not to a session: nobody is watching it.
- **A fallback, not a fork.** When the `omp` binary or the broker is unavailable, the same runner
  runs inside the operator's session, with the same journal — `/distill status` then reports a scan
  whose journal exists and whose daemon does not.
- **Liveness is the scan lock, not a pid.** `/distill status` asks the only question that cannot
  lie — can I take the lock? — and gives it straight back: held means a scan is running, free means
  nothing is, whatever the files claim (a pid file would be wrong on reuse and wrong forever after a
  SIGKILL). The broker fills in what the lock cannot say: the pid, and the few seconds between the
  spawn and the runner taking the lock. The journal supplies everything else — progress, and the
  session it is on, path and all, so the runner never has to resolve the store again under its own
  environment.

**Considered Options**: keep the scan in-process and document the loss — rejected by the operator,
and the loss is the most expensive thing the plugin does; spawn a detached child ourselves with a pid
file, a log file and a cancel poll — rejected, the broker is exactly that plus `omp ps`, output
capture, stop, restart and recovery of detached records across broker restarts, and reinventing it
would be four files of supervision code to maintain; hand the scan to the host's in-process
`AsyncJobManager` (the one behind `ctx.getAsyncJobSnapshot()`) — rejected, the extension surface is
read-only there and the manager dies with the host, which is the problem being solved.

**Amended 2026-09-25**: the broker half of this did not survive contact with an installed plugin.
`@oh-my-pi/pi-coding-agent/launch/client` does not resolve from a marketplace install and the package
root does not export it — the same wall ADR-0011 recorded for two other subpaths — so the plugin owns
the spawn after all: `Bun.spawn({ detached: true })` plus `unref()`, which is all the broker gave it
here (ADR-0011's rule is why the forty lines are cheaper than the dependency). Nothing else moved:
the journal, the scan lock and the cancel request are unchanged, and a scan therefore appears in no
`omp ps`.

**Amended 2026-09-25 (the spawn's argv is load-bearing)**: the runner is started as
`omp -p --no-session "/distill _job"`, and `--no-session` is not tidiness. Without it the host
attaches the print run to the project's newest session and appends a `session_exit` marker to it on
the way out — verified both ways in a scratch project, where a plain `omp -p "/distill status"` grew
the newest session's file from 825 to 1032 bytes and the same run with `--no-session` left it alone.
A scan would then be the one thing that writes to the store ADR-0006 calls read-only input, once per
scan, in the background where nobody sees it. The runner reads its journal rather than the store, so
it needs no session of its own.
