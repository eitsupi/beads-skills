---
name: beads-search-full
description: Recover context and discover relevant records across long-lived Beads history with relevance-ranked FTS5 search. Prefer it for resuming previous work, reconstructing decisions, finding comments or related issues from natural-language concepts or partial clues, and retrying noisy literal searches. Do not use for a known exact issue ID or exhaustive literal/regex matching.
license: MIT
---

# Beads Search Full

Use this skill to retrieve a small, relevance-ranked set of issues from a
long-lived Beads history. It requires Bash, the Beads CLI (`bd`), and Deno with
the built-in `node:sqlite` module and SQLite FTS5 support.

## When to use

Prefer this skill over ordinary `bd search` when the goal is context recovery or
candidate discovery rather than exhaustive matching. Typical triggers are:

- resuming work from a previous session;
- reconstructing why a decision was made or recovering design rationale;
- finding relevant comments or related tasks when the exact wording is unknown;
- searching by natural-language concepts, partial clues, or identifiers;
- retrying after literal search returns no useful match or too many noisy
  matches.

If an exact issue ID is known, inspect it directly with `bd show`. Use ordinary
`bd search` for fast title, ID-prefix, and structured-field filtering.

Always invoke the wrapper with `bash`. Do not execute it directly because an
installed skill may not preserve executable permission bits:

```bash
bash <skill-directory>/scripts/search.sh search "natural language query"
bash <skill-directory>/scripts/search.sh search --limit 10 "ipc_policy"
bash <skill-directory>/scripts/search.sh search --open --json "PR#330"
```

The wrapper resolves the effective shared `.beads` directory through
`bd where --json`, canonicalizes it, and gives Deno read/write access only to
that directory. The TypeScript program independently resolves the directory and
rejects a mismatch before opening the index. Redirected workspaces and worktrees
that share Beads data therefore use the same `.beads/search-index.db`.

## Freshness

Every search writes a compact index notice to stderr. A normal search reports
the build time, issue count, and `freshness=unchecked` without running an
expensive export. Search results remain exclusively on stdout.

Use an explicit check when deciding whether a full rebuild is necessary:

```bash
bash <skill-directory>/scripts/search.sh search --check "query"
bash <skill-directory>/scripts/search.sh status --check --json
```

`--check` streams a new `bd export`, compares its normalized fingerprint with
the stored fingerprint, and reports `freshness=current` or `freshness=stale`. It
does not rebuild. This check costs roughly as much as an export, so do not run
it before every query.

Use `--fresh` to check and rebuild only when stale, or `reindex` to rebuild
unconditionally:

```bash
bash <skill-directory>/scripts/search.sh search --fresh "query"
bash <skill-directory>/scripts/search.sh reindex
```

The first search also rebuilds a missing or incompatible index. A failed rebuild
rolls back and preserves the previous complete index.

## Retrieval and output

The disposable index is derived from streamed `bd export` JSONL. Beads remains
the sole source of truth, and the index may be deleted and rebuilt at any time.
Contentless `unicode61` and `trigram` FTS5 indexes cover title, description,
design, acceptance criteria, notes, close reason, and comments. Weighted BM25
candidate lists are combined with reciprocal-rank fusion for prose, identifiers,
punctuation-bearing terms, and substring-like matching. The prose index inserts
boundaries between adjacent ASCII and non-ASCII alphanumeric characters, while
the trigram index keeps original field text. Punctuation and whitespace are not
removed from the trigram evidence.

Text output is a compact tab-separated table. `--json` returns rank, issue
metadata, retrieval path, and title without full bodies or comments. Use
`bd show` only for useful candidates.

This skill intentionally does not provide exhaustive literal or
regular-expression search. It also cannot match arbitrary substrings shorter
than three characters, especially CJK substrings. When a task requires those
semantics, treat this limitation explicitly rather than presenting the ranked
results as exhaustive.
