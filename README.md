# beads-skills

A collection of [Agent Skills](https://agentskills.io) for working with [Beads](https://github.com/gastownhall/beads), a distributed graph issue tracker for AI agents.

These skills were extracted from real-world usage patterns where the standard `bd` CLI fell short or required non-obvious workarounds.

## Skills

### [`search-full-text`](skills/search-full-text/SKILL.md)

Full-text search across **all** beads issue fields — title, description, notes, close\_reason, and comment text.

Use this instead of `bd search`, which only searches titles. Includes closed issues by default.

**Prerequisites:** `bd` CLI, `dolt` CLI

### [`triage-roborev-review`](skills/triage-roborev-review/SKILL.md)

Triage and resolve [roborev](https://github.com/roborev-dev/roborev) review findings tracked as beads tasks
via the built-in Beads Integration hooks.

Discovers open review tasks, presents findings with recommended actions, fixes approved issues, and closes both the roborev review and the bd task — with explicit user confirmation at each decision point.

**Prerequisites:** `bd` CLI, `roborev` CLI, git

## Installation

Copy the skill directories you want into your agent's skills folder. Refer to your agent's documentation for the correct directory path and invocation syntax.

## Requirements

- [Beads](https://github.com/gastownhall/beads) (`bd` CLI)
- [Dolt](https://github.com/dolthub/dolt) (`dolt` CLI) — required by `search-full-text`
- [roborev](https://github.com/roborev-dev/roborev) (`roborev` CLI) — required by `triage-roborev-review`

## License

MIT
