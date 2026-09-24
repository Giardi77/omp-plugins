# Review is a terminal window, and nothing else can reach it

Status: accepted

`/distill review` mounts one component through `ctx.ui.custom`: the undecided lessons as a list, the
selected lesson's text, target and citations beneath it, arrow keys to move, `a` to accept, `d` to
deny with an optional one-line reason, `q` to quit. Accept writes immediately — the window has already
shown the target file and the exact text — a decided lesson leaves the list, and anything untouched
stays proposed.

**Considered Options**: a dialog loop built from `ui.select` and `ui.input`, with a lesson's detail
carried in a dialog title — that is the only shape that works wherever `ctx.hasUI` is true, RPC
included, and it was rejected because three dialogs per lesson is not a review surface; a headless
`approve <id>` / `deny <id>` pair — rejected because the decision this loop exists for is a person
reading text before it lands in a skill, and a command taking an id invites approving without reading.

**Consequences**: review needs the terminal. RPC implements `select`, `confirm` and `input` but stubs
`custom`, and print mode has no UI object at all, so `/distill review` reports that it needs the
terminal in both rather than silently doing nothing. The cost is deliberate: neither a script nor an
agent can approve a lesson, so the loop has exactly one gate and a person stands at it.
