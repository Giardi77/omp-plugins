# OMP Setup Skills Extension

Adds one OMP command:

```text
/setup-skills
```

It opens a small checkbox menu for the current project so you can enable or disable discovered OMP skills without editing YAML by hand.

## Install from the Giardi plugins marketplace

If you previously installed this plugin directly from GitHub, remove that install first to avoid loading the same command twice:

```bash
omp plugin uninstall omp-setup-skills-extension
```

Add the marketplace and install this plugin:

```bash
omp plugin marketplace add Giardi77/omp-plugins
omp plugin install omp-setup-skills-extension@giardi-plugins
```

If OMP is already running, restart it after installing so the extension is loaded.

## Local development install

For a local checkout:

```bash
omp plugin link /path/to/omp-plugins/plugins/setup-skills
```

Then restart OMP.

## Use

Open OMP inside a project and run:

```text
/setup-skills
```

Keys:

```text
↑/↓ or j/k  move
Space       toggle selected skill
a           enable all
n           disable all
Enter       save and reload skills when the agent is idle
Esc         cancel
```

## What it changes

On save, the extension writes the project config file:

```text
<repo>/.omp/config.yml
```

It updates only the `skills` section:

- default mode uses `skills.ignoredSkills` to disable unchecked skills
- existing allowlist mode uses `skills.includeSkills` to keep only checked skills

After saving, it waits until the agent is idle. On OMP builds that expose `ctx.refreshSkills()`, it asks core to rediscover skills and rebuild `/skill:` completions from the saved config. Older runtimes fall back to a local skill reload plus `ctx.reload()`. If that session rewrite races, the config is still saved; restart OMP if skill commands do not update.

## Uninstall

Marketplace install:

```bash
omp plugin uninstall omp-setup-skills-extension@giardi-plugins
```

Direct Git/local install:

```bash
omp plugin uninstall omp-setup-skills-extension
```
