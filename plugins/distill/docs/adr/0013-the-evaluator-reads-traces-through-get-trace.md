# The evaluator reads traces through `get_trace`

Status: accepted

A scan used to hand the evaluator the session's whole rendered trace as its first message. Measured on
one real session — a 3.2 MB transcript with nine subagents — that payload was 3.7 M characters (over
the model's window, so the run failed outright), and after summarising tool results it was still
2.0 M characters against a 16.7 M-byte raw store. The operator's call: the evaluator may fetch what it
needs, so stop flooding it.

The first message is now an **inventory**: the session, the project, and one block per trace with its
id, label, record range, rendered size and transcript file. Nothing else. Records arrive through a
fourth sealed tool, `get_trace`, in three modes — a record range, a case-insensitive pattern, or a
`jq` filter over that trace's records — each response bounded (60 records, 40 000 characters) and
footed with where to continue. Tool results stay summarised inside a section; the trace file path
stays in the inventory so the raw record is one read away when a detail decides a lesson.

Consequences that had to be settled with it:

- **Citations resolve against the bundle, not against what was sent.** A lesson may cite any record
  in the session that it read through a section; the plugin holds the bundle in memory for the run, so
  `trace:record` still names a real record and the excerpt still comes from the full record.
- **The ledger's `reads` gained the fetches** (`get_trace <trace> records 12..71`), so the record
  shows which sections an evaluation actually looked at, not just which files it opened.
- **The payload planner's job changed.** Splitting and packing now guard the *inventory*, not the
  records: they trigger only for a session with so many traces that the inventory itself would not
  fit, so they are a cost and latency lever rather than the hard size limit they were written as.
- **Reachable by design.** This paragraph first gave a second reason for rejecting raw reading —
  that it exposes fields the render leaves out — and that reason was wrong the moment `get_trace`
  arrived: its `jq` filter reads the same records unfiltered, and the inventory hands over the
  transcript path, so `read` reaches them too. `include_thinking` and the elision of tool results
  decide what the *rendered sections* show, never what the evaluator may read (ADR-0005: distill
  masks nothing). The operator confirmed this is the intent: the sections are for reading, not for
  gating.
- **`jq` is run by the plugin, not by a shell.** The evaluator gains no `bash`: the filter is one
  argv element, the input is the trace's own records as NDJSON, the module search path is empty so
  `include`/`import` cannot read the filesystem, output is capped, and the process is killed on
  timeout. Absent `jq` is a message, not a failure.

**Considered Options**: keep the whole rendered trace and accept the flood — rejected by the operator
and by the failure that started this (a payload larger than the model's window is not a judgement
problem, it is a bug); let the model read the raw JSONL itself with `read`/`grep` — rejected, the raw
store is eight times the bytes for the same information and it requires the model to reconstruct the
active branch; give the
sealed session `bash` so it can run `jq` itself — rejected, one tool for exact extraction is a smaller
grant than an arbitrary shell; a `payload: digest | skeleton` config key — rejected as a knob for a
decision the plugin can make on its own.

**Consequences**: an evaluation now spends part of its run reading before it can judge, and the
deadline bounds both; the evaluator can only cite what it read, which is the point. The 3.2 MB session
goes from one impossible run to one run whose first message is 432 characters.
