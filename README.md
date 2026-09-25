# Giardi OMP Plugins

This repository is an OMP plugin marketplace.

## Install the marketplace in OMP

Add this repository as an OMP marketplace:

```bash
omp plugin marketplace add Giardi77/omp-plugins
```

Verify that OMP can see the marketplace and its plugins:

```bash
omp plugin marketplace list
omp plugin discover giardi-plugins
```

Install a plugin from the marketplace:

```bash
omp plugin install omp-setup-skills-extension@giardi-plugins
```

If OMP is already running, restart it after installing so the extension is loaded.

## Available plugins

| Plugin | Description |
| --- | --- |
| [`omp-ponytail-extension`](plugins/ponytail) | Lazy senior dev mode with `/ponytail`: ruleset, six skills, status-line chip. Forked from [@dietrichgebert/ponytail](https://github.com/DietrichGebert/ponytail). |
| [`omp-setup-skills-extension`](plugins/setup-skills) | Select enabled skills for an OMP project with `/setup-skills`. |
| [`omp-distill-extension`](plugins/distill) | Turn recorded sessions into reviewed project knowledge with `/distill`. |

## Update installed marketplace plugins

Refresh the cached marketplace catalog before upgrading:

```bash
omp plugin marketplace update giardi-plugins
omp plugin upgrade
```

## Repository layout

```text
.omp-plugin/marketplace.json      Marketplace catalog
plugins/ponytail/                 ponytail plugin package
plugins/setup-skills/             setup-skills plugin package
plugins/distill/                  distill plugin package
plugins/telegram/                 telegram plugin package
```

Each plugin lives in its own directory under `plugins/`, with its own `package.json`, source, tests, and README.
