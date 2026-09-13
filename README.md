# beads-skills

A collection of [Agent Skills](https://agentskills.io) for working with [Beads](https://github.com/gastownhall/beads), a distributed graph issue tracker for AI agents.

These skills were extracted from real-world usage patterns where the standard `bd` CLI fell short or required non-obvious workarounds.

## Skills

### [`search-full-text`](skills/search-full-text/SKILL.md)

Full-text search across **all** beads issue fields — title, description, notes, close\_reason, and comment text.

Use this instead of `bd search`, which only searches titles. Includes closed issues by default.

**Prerequisites:** `bd` CLI, `dolt` CLI

### [`triage-roborev-review`](skills/triage-roborev-review/SKILL.md)

Track an already-enqueued [roborev](https://github.com/roborev-dev/roborev)
review after a commit, or evaluate findings recorded as Beads tasks, then
reconcile resolved FAIL reviews and their tasks while respecting authorization.

**Prerequisites:** `bd` CLI, `roborev` CLI, git

### [`add-beads-comment`](skills/add-beads-comment/SKILL.md)

Add durable Beads issue comments with input-selection guidance, recommending
quoted heredocs for shell-sensitive or multiline content and avoiding
unintentional expansion or duplicate retries.

**Prerequisites:** `bd` CLI

## Installation

Copy the skill directories you want into your agent's skills folder. Refer to your agent's documentation for the correct directory path and invocation syntax.

## Requirements

- [Beads](https://github.com/gastownhall/beads) (`bd` CLI)
- [Dolt](https://github.com/dolthub/dolt) (`dolt` CLI) — required by `search-full-text`
- [roborev](https://github.com/roborev-dev/roborev) (`roborev` CLI) — required by `triage-roborev-review`

## License

MIT
