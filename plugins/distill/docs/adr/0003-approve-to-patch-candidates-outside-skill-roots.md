# Approve to patch, and proposed lessons never live in a skill root

Status: accepted

The workspace runs skills in denylist mode, so any new directory under `.omp/skills/` becomes
active in the next session with no config change — the shortest path to the silt of near-duplicate
skills that motivated this plugin. Proposed lessons are therefore stored in `.omp/distill/lessons/`,
outside every skill root, and only an approval writes into one. The proposer must first look for
an existing skill to patch; minting a slug is the fallback, and the review screen shows both the
overlap check it performed and the exact diff it will write.

**Considered Options**: a new skill per lesson (rejected: flooding); hand-editing only
(rejected: that is the work this plugin exists to reduce); writing to `.agents/skills/` in the
project (rejected: a second skill root for no gain, and the user-level `~/.agents/skills` leaks
into every workspace that walks up to home).

**Consequences**: patches are append-only, in a dated section, so existing hand-written prose is
never rewritten; and every proposed lesson carries an evidence list naming the records it came from,
which is validated against the trace before the lesson reaches the queue. The set of surfaces an
approval can reach is wider than the two this ADR named — rules, skill references and
`APPEND_SYSTEM.md` joined them in ADR-0012; this ADR's posture (edit before adding, append-only,
the loader's own constraints) is what all of them inherit.

A minted skill has to survive the loader, which drops it **silently** in one case and rejects it
loudly in the rest. (ADR-0011 later replaced the import with a verbatim mirror in
`src/skill-rules.ts`, for the same rules: a compiled host cannot serve the `autolearn/managed-skills`
subpath, and a failed extension load registers nothing at all.) The silent one: the project skill provider passes `requireDescription: true`, and
`scanSkillsFromDir` skips any `SKILL.md` whose frontmatter has no `description`
(`discovery/builtin.ts:286-292`, `discovery/helpers.ts:400-402`) — no error, the skill simply never
appears. A writer that does not know this will report success for a skill nobody can see. The
harness already solved this class in `autolearn/managed-skills.ts`, and those helpers are exported and resolve
from the pinned SDK, so approval imports them rather than re-deriving the rules: a name matching `^[a-z0-9][a-z0-9-]{0,63}$` or it throws; a description
passed through `sanitizeManagedDescription`, which strips control characters, angle brackets and fence
delimiters because the description is rendered into the system prompt's `<skills>` listing — a trust
boundary, applied on read as well as write so pre-existing files cannot inject either; a size cap
measured on the final file's UTF-8 bytes rather than on the body; and a write path that refuses
symlinks and hard-linked files, creates with `O_CREAT|O_EXCL`, and serializes mutations per skill
name. Distill writes into the project's own skill root rather than `getManagedSkillsDir()`, so
`writeManagedSkill` itself is not reusable — the write path is ours — but the validation, the
sanitization and the constraints above are.
