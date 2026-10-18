# simple-mod-marketplace

Claude Code mods by Apocalypse03.

| Plugin | What it does |
| --- | --- |
| `plugin-auditor` | `/plugin-audit` opens a pane that audits installed plugins and mods, with enable, disable and remove actions |
| `permission-explainer` | Explains each permission prompt in plain English in a side pane |
| `loop-timer` | Shows each `/loop` as a timer ring above the prompt, with controls to stop it or change its interval |

## Install

Sessions opened in this repository pick the marketplace and all three plugins up from `.claude/settings.json` (accept the prompt to install the marketplace when the folder is trusted).

Anywhere else, at the prompt of a terminal session:

```
/plugin marketplace add Apocalypse03/Claude_Plugins
/plugin install loop-timer@simple-mod-marketplace
```

From a shell:

```
claude plugin marketplace add Apocalypse03/Claude_Plugins
claude plugin install loop-timer@simple-mod-marketplace
```

Swap `loop-timer` for `plugin-auditor` or `permission-explainer`, then run `/reload-plugins`.
