# omp-ponytail-extension

[Ponytail](https://github.com/DietrichGebert/ponytail) — lazy senior dev mode — as an OMP plugin:
the always-on ruleset, the six skills, and a `🐴 <mode>` chip in the status line.

Forked from [`@dietrichgebert/ponytail`](https://github.com/DietrichGebert/ponytail) at 4.9.0
with [the status-line PR](https://github.com/DietrichGebert/ponytail/compare/main...Giardi77:ponytail:omp-statusline)
applied, then ported to the OMP 18 extension API. MIT, upstream copyright kept in [LICENSE](LICENSE).

## Install

```sh
omp plugin install omp-ponytail-extension@giardi-plugins
```

Restart OMP afterwards. If the upstream marketplace plugin is installed, remove it first — both
register the same `ponytail` skills and commands:

```sh
omp plugin uninstall ponytail@ponytail
```

## Use

| Command | Effect |
| --- | --- |
| `/ponytail` | Re-activate at the configured default level. |
| `/ponytail lite\|full\|ultra` | Switch level for this session. |
| `/ponytail off` | Turn it off. |
| `/ponytail status` | Show current and default level. |
| `/ponytail default <lite\|full\|ultra>` | Persist the default level. |
| `/ponytail-review`, `-audit`, `-debt`, `-gain`, `-help` | Run the matching skill. |

Say "stop ponytail" or "normal mode" to turn it off. The ruleset is injected on every turn while a
level is active; the level persists with the session.

### Status line

`🐴 <mode>` sits next to the `mode` segment — accent while the agent runs, muted when idle. It rides
every built-in preset except `ascii` (which stays emoji-free), so no config change is needed.
Hosts without the segment registry, and `statusLine.preset: custom` configs (whose segment list is
validated against the host's catalog), get the mode as a hook line under the composer instead.
`PONYTAIL_HIDE_STATUS=1` or `{"hideStatus": true}` hides the chip and keeps the ruleset active.

The chip uses OMP's `SEGMENTS` / `STATUS_LINE_PRESETS` exports — OMP has no extension-segment API as
of 18.3.1 — so a host that stops exporting them degrades to the hook line, never a load failure.

## Config

Level resolution, highest first: `PONYTAIL_DEFAULT_MODE` → `~/.config/ponytail/config.json`
(`{"defaultMode": "lite"}`) → `full`. `{"quietStartup": true}` skips the startup notice.

## Differences from upstream

- Status line renders inline through the host's segment registry instead of the composer hook line.
- `before_agent_start` appends the ruleset as a new prompt part instead of flattening the host's
  `systemPrompt` array into one string with commas.
- Only the OMP pieces ship: the extension, the two shared hook modules, and the skills. Other-host
  adapters (Claude Code, Codex, Copilot, Qoder, OpenCode, Gemini) stay upstream.

## Test

```sh
node --test tests/*.test.js
```
