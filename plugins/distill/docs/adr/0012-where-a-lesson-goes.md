# Where a lesson goes: the project's own surfaces

Status: accepted

A proposed lesson names the surface it would be written into, and the plugin only offers surfaces
that already exist in OMP: `.omp/skills/<slug>/SKILL.md` (and `references/` beneath it),
`.omp/rules/<name>.md`, `.omp/agents/<name>.md`, and `.omp/APPEND_SYSTEM.md`. D6 had put the last
two prompt layers — `APPEND_SYSTEM.md` and `RULES.md` — out of scope, with skills and subagent
prompts as the only targets; that exclusion is withdrawn for `APPEND_SYSTEM.md`, because the
operator wants the loop to reach the surface an instruction actually belongs to, and the review
window shows the target file and the exact text before anything is written. `RULES.md` stays out:
its purpose overlaps `APPEND_SYSTEM.md` and the rules directory (ADR-0003), and none of the three
needs a fourth spelling.

The kind vocabulary is one name per surface: `skill` (the slug decides patch or mint, so the
proposer cannot duplicate a skill by proposing it twice), `skill_reference` (the reference file plus
the line in `SKILL.md` that points at it), `rule`, `agent_prompt`, and `append_system`. The earlier
`patch_skill`/`new_skill` split is gone: "does this slug exist?" is a fact about the filesystem, and
the writer answers it; leaving it to the model asked it to guess at something it cannot see.

A rule carries `applies_to`, a one-line trigger in the host's own frontmatter vocabulary
(`always`, `globs:<glob>`, `condition:<regex>`, `ast:<pattern>`, `agent:<name>`, or nothing for a
description-listed rule). An existing rule's frontmatter is the operator's; a patch that asks for a
different trigger is refused rather than silently merged, and adding to the body is unchanged.

**Considered Options**: teaching the model the raw frontmatter and letting it write whole files —
rejected, the plugin would be validating model-authored YAML for no gain, and the review window
would show a file rather than a lesson; a free-text `target` field with no vocabulary — rejected,
the writer needs a surface it can validate before the model spends its run on a proposal that
cannot be written; keeping `RULES.md` as a target — rejected as a third spelling of the same idea;
`alwaysApply` for every rule — rejected, an always-on rule's full text rides every request, which
is exactly the bloat the operator asked to avoid.

**Consequences**: the answer contract's kind list is a live interface with the host's discovery —
`rule` frontmatter keys and the `references/` convention are mirrored from the host's
`RuleFrontmatter` and skill scanning, so a host change is a plugin change (the mirrors live in
`src/skill-rules.ts` and `src/writer.ts`, and D15 keeps the mechanics in the `propose_lessons`
description where they cannot drift from the schema). The default evaluator prompt states the
placement criteria as taste, so a project that edits its prompt can re-aim the loop without
touching the plugin. Approval remains the only write path: every surface is reached through
`planWrite`, which refuses a missing target, an unknown agent, a reference without its skill, a
symlinked trail, and any write that would exceed the loader's cap.
