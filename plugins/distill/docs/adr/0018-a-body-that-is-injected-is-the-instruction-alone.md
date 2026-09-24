# A body that is injected is the instruction alone

Status: accepted

Every lesson body was written to one shape: the problem, the moment it bit, the instruction, three to
six lines. That shape is right for a skill, which a future session *opens* once it recognises the
problem — the instance is what makes it believable and findable, which is why a reference has to open
with the sentence saying what it covers. It is wrong for the three surfaces that are *injected*: a
rule lands in the stream the moment its trigger matches (the host interrupts the generation and
re-asks with the rule's text in hand, `rule.content` inside a `<system-interrupt reason="rule_violation">`
block), and an `agent_prompt` or `APPEND_SYSTEM.md` addition rides every request that agent makes.
There the instance is not evidence a reader chose to fetch; it is context paid for at every match,
from now on. One session's rule came back at ~800 characters, two thirds of them the story of the
sweep that motivated it.

So an injected body is the instruction alone — the problem, the instance, the figures and the cost go
to `rationale`, the one field nothing after review loads — and *how short that is* stays the project's
call, stated in its own `evaluator.md`. The contract states which body belongs to which kind, because
that is what the field means; it does not measure it.

**Considered Options**: a hard character cap on injected bodies (400, refused by the parser, with the
reason in the tool error) — written first, then withdrawn by the operator: "no i don't like the hard
cap. we can just instruct the evaluator in the evaluator.md prompt". A refusal spends a round trip
inside a run that may already have cost its deadline, and the file the operator owns is the right place
to say how terse their own rules are; a cap with no exemption for a rule that legitimately needs four
lines is a taste decision being smuggled into a validator. Leaving the shape unstated and trusting the
model — rejected: the same description that asked for three to six lines produced 800-character rule
bodies, so the shape is stated, just not enforced.

The four host keys a lesson cannot write stay out of the vocabulary for a structural reason:
`applies_to` is one string holding one trigger, so a trigger *plus* a modifier has no room there. That
is a new lesson field, a schema change and an `ANSWER_CONTRACT_VERSION` bump — the size of ADR-0016,
not a line in a description. For the record, in case that field is ever added:

- `scope` (`text` | `thinking` | `tool` | `toolcall` | `tool:<name>(<glob>)`) — which streams the
  condition is matched against. It is the precision half of the trigger, and the half that decides
  whether a rule about a *command* also fires on prose about the command.
- `interruptMode` (`never` | `prose-only` | `tool-only` | `always`, the global default) — whether a
  match interrupts the generation or the text is folded into the tool result instead. `never` is
  cheaper: nothing is re-asked.
- `question` — a natural-language yes/no a judge model answers on every completed in-scope output.
  The only non-regex trigger the host has, and the only one that bills a model call per output.
- `enabled: false` — discovery omits the rule entirely. That is a disable lever for an operator, not
  something a proposal should set: an approved lesson is meant to be live.

**Consequences**: nothing stops a long rule body at write time. The reviewer is the gate — the diff
shows the file, and a body that has grown past what it earns is a `removes` lesson (ADR-0016), which
is how this project already trims a surface rather than rewriting it. The instruction is in the shipped
`templates/evaluator.md`, which keeps the read form as its worked example and shows the injected form
as that example's last sentence; a project set up before this change keeps its own copy, because
`setupProject` writes the prompt only when one is missing, so the shape reaches it by copying the
paragraph across. The `body` field's own description carries the kind split, so a model that never
reads the prompt still knows what belongs in the field. `ANSWER_CONTRACT_VERSION` stays at 2: no field
was added or removed.
