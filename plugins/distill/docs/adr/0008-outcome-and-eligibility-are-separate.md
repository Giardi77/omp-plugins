# What an evaluation reports, and what retires a trace

Status: accepted

An evaluation's **outcome** and its effect on **eligibility** are deliberately separate, because one
is a description and the other is a schedule. The outcome is what the operator sees: `lessons` (n
proposed), `empty` (ran to completion and proposed nothing — recorded as a failure with reason
`empty`, since an empty run is the only evidence that the evaluator missed something), or
`failed{reason}` for timeout, parse and exit faults. Retirement reads *execution* instead: a trace is
retired once it has any evaluation that ran to completion, whatever that evaluation yielded. Only
technical faults leave a trace in the default scan set, so an explicit retry remains one command
away. `purge` is the only thing that re-opens a retired trace, and editing `evaluator.md` re-opens
nothing.

**Considered Options**: keying eligibility on (evaluator-prompt hash, contract version) so that
editing the prompt re-opens the whole history — rejected by the operator, because an evaluator-prompt
edit must not silently re-evaluate past sessions; recording an empty run as a plain success — rejected, because it
hides the only signal that distinguishes a boring corpus from a broken evaluator; letting empty runs
stay eligible the way technical faults do — rejected, because it re-pays for the same dud traces on
every scan, which is the flooding worry inverted.

**Amended 2026-09-24**: the recorded upgrade path was taken, because a real session hit the limit —
a 3.2 MB transcript whose 10 traces came to 3.7 M characters, past the 1 M-token window of the
model it named. A scan now sends the whole bundle while it fits, and otherwise one trace per
evaluation, which is also what the per-trace retirement in this ADR already implied: each run
records its own outcome and retires exactly the trace it covered. A trace that does not fit on its
own still fails loudly with its size and stays eligible; no payload is ever truncated.

**Consequences**: the evaluator-prompt hash stays in the ledger as provenance rather than as a key, so
`/distill status` can report "N traces were evaluated under an earlier `evaluator.md`" — a prompt
edit's coverage becomes visible without anything re-running. A payload too large for the model is a
technical fault and therefore stays eligible: it fails loudly and visibly rather than being truncated
silently, which is the predecessor's failure mode; splitting an oversized session by trace is the
recorded upgrade path if a real session ever hits the limit. Retirement is measured per **trace**, not
per session, so a session evaluated in more than one pass retires only when every trace is covered.
