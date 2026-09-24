# Host imports go through package roots, and the gaps are mirrored

Status: accepted

A compiled omp host rewrites an extension's *static* imports of `@oh-my-pi/*` onto the copies bundled
inside the binary, but only for the surfaces its build registered. Package roots
(`@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-natives`) resolve.
Three subpaths distill used do not: the host resolved them to the on-disk npm copies in the Bun store,
whose own nested imports it cannot resolve, and the whole extension load failed with

```
Failed to load extension: Cannot find package '@oh-my-pi/pi-natives' imported from
/Users/giardi/projects/omp-plugins/node_modules/.bun/@oh-my-pi+pi-utils@18.3.0/node_modules/@oh-my-pi/pi-utils/src/file-lock.ts?mtime=...
```

A failed load registers nothing, so `/distill` fell through to the model as ordinary prompt text, with
the reason visible only in `~/.omp/logs/omp.<date>.<pid>.log`. Measured on omp 18.3.0: importing
`@oh-my-pi/pi-utils/file-lock`, `@oh-my-pi/pi-tui/thinking` or
`@oh-my-pi/pi-coding-agent/autolearn/managed-skills` fails the load, while the package roots and the
subpaths `@oh-my-pi/pi-tui/chrome` and `@oh-my-pi/pi-coding-agent/session/session-loader` load.

The extension therefore takes runtime host APIs from package roots only. `withFileLock` and
`acquireFileLock` are re-exported by `@oh-my-pi/pi-utils`, so that swap is free. Two surfaces the host
does not export anywhere — the managed-skill rules (`autolearn/managed-skills`) and the `--thinking`
selectors (`pi-tui/thinking`); neither the SDK root nor `pi.pi` carries them — are mirrored in
`src/skill-rules.ts` and `src/thinking.ts`, keeping the host's names, messages and limits verbatim.

**Considered Options**: keep the subpath imports and wait for the host to register them — rejected,
the plugin does not load at all in the meantime, and a load failure is silent to the operator; import
the host modules by relative path into `node_modules` — rejected, the graph rewrite covers only the
extension's own sources, so the on-disk copy's nested imports fail identically; vendor the host's
`managed-skills.ts` whole — rejected, it carries the managed-directory write/delete machinery distill
never uses (it writes project skills, under approval), while the four rules it does use are the ~40
lines mirrored; re-derive the behavior from memory — rejected in favor of transcribing the host's
exact messages and limits, so the mirror is a copy rather than a paraphrase.

**Consequences**: the mirrors can drift from the host. Each header names the host module and version
it was taken from, `test/skill-rules.test.ts` and `test/thinking.test.ts` pin the observable behavior,
and the extension-load check in AGENTS.md fails at load time rather than at write time. When the host
exposes these surfaces, delete both mirrors and import them again.
