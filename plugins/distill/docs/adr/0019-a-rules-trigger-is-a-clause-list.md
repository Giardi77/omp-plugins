# A rule's trigger is a clause list, not one string

Status: accepted

`applies_to` held one clause — `always`, `globs:<glob>`, `condition:<regex>`, `ast:<pattern>` or
`agent:<name>` — and each one wrote one frontmatter key. Two of the host's keys had no way in, and they
are the two that decide what a rule *costs*: `scope` (which streams the condition is matched against —
the difference between a rule about a command and one that also fires on prose discussing it) and
`interruptMode` (whether a match stops the generation and re-asks, or folds the text into the tool
result and asks for nothing again). Neither replaces a trigger. Both shape one, and one string has no
room for a trigger plus a modifier.

So `applies_to` takes one clause or a list of them, each clause writing one frontmatter key: `always` →
`alwaysApply`, `condition:` → `condition`, `ast:` → `astCondition`, `globs:` → `globs`, `agent:` →
`agents`, `scope:` → `scope`, `interrupt:` → `interruptMode`. One trigger at most, because the host's
buckets are exclusive — a rule is TTSR, or always, or listed, never two of them — and `scope:` and
`interrupt:` need a `condition:` or `ast:` to shape. A clause list with no trigger in it is still a
rule: listed by its description, never injected, which is the cheapest rule there is.

Two keys stay out, deliberately:

- **`question`** — a natural-language yes/no a judge model answers on every completed in-scope output.
  The host's only non-regex trigger, and the only one that bills a model call per output. Spending
  someone's tokens on every future run is the operator's call, not a lesson's; the tool description says
  so, and `rationale` is where a proposal argues for one.
- **`enabled: false`** — discovery drops the rule. A proposal that writes something nobody can see is
  not a proposal; disabling is how an operator retires a rule.

**Considered Options**: a `rule_settings` field beside `applies_to` — rejected as two fields that must
agree about one frontmatter, with no answer for which of them wins when they disagree; teaching the
model raw frontmatter and writing it — rejected in ADR-0012 and again here, the plugin would validate
model-authored YAML for no gain; `scope` and `interruptMode` as their own lesson fields — the same
disagreement one level down; leaving both out and explaining them in the description instead — rejected
by the operator: "explain also the rule frontmatter keys so it knows how to use them", and a key a
lesson cannot set is not one it can use.

**Consequences**: `ANSWER_CONTRACT_VERSION` is 3, because an answer under v2 and one under v3 are not
the same shape. A stored lesson keeps what it was given — a string or a list — so a lesson proposed
before this change writes the same file it always did. The writer refuses a clause set that cannot mean
anything (two triggers, a modifier with nothing to shape, a scope token the host would drop) rather than
writing half a trigger, which makes a hand-edited lesson file a loud failure. `ruleTriggerMatches`
reads every clause instead of switching on one kind: appending is allowed only when the file already
carries each clause the lesson asks for, so a new `scope:` on an existing rule is refused exactly the
way a new condition always was — the frontmatter belongs to the operator (ADR-0012).
