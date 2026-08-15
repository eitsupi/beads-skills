---
name: search-full-text
description: >
  Full-text search across ALL beads issue fields (title, description, notes,
  close_reason) and comment text. Use this — not `bd search` — when you need
  keyword hits across any field, or when `bd search` returns no results.
  Includes closed issues by default.
compatibility: Requires the beads CLI (`bd`), Dolt CLI (`dolt`), and access to a local beads database.
license: MIT
---

Search beads issues and comments for `$0`. Surface useful matches to the user.

`$0` is one or more keywords or phrases. Pass `--open` to restrict results to non-closed issues.

If `$0` appears truncated (e.g., user typed `PR #1234` but `$0` is just `PR`), infer the full intended keyword from the original user message and use that.

Stay in the target beads workspace and invoke the bundled script by its resolved path. Do not `cd` to the skill directory because `bd info` resolves the database from the working directory.

```bash
<skill-directory>/scripts/search-full-text.sh [--open] [--regex] "<search term>" ["<search term>" ...]
```

## Search semantics

Treat each positional argument as one literal substring search term. Multiple arguments always use **OR**, never AND: an issue is returned when any term occurs in any searched issue field or comment.

```bash
# One term
<skill-directory>/scripts/search-full-text.sh foo

# Two terms using OR: matches either foo or baz
<skill-directory>/scripts/search-full-text.sh foo baz

# One phrase: matches the contiguous substring "foo bar"
<skill-directory>/scripts/search-full-text.sh "foo bar"

# A phrase OR another term
<skill-directory>/scripts/search-full-text.sh "foo bar" baz
```

The script has no native AND mode. If the user explicitly requests AND, do not pass the terms as separate arguments and claim an AND search. Run one search per term and intersect the returned issue IDs, or report that native AND search is unsupported.

Pass `--regex` to interpret each argument as a regular expression instead of a literal substring. Multiple regular-expression arguments still use OR. Regular expressions are case-sensitive by default; use `(?i)` for case-insensitive matching.

```bash
# Alternation in one regular expression
<skill-directory>/scripts/search-full-text.sh --regex 'foo|baz'

# Both terms in either order, within the same field or comment
<skill-directory>/scripts/search-full-text.sh --regex '(?=.*foo)(?=.*bar)'

# Case-insensitive matching
<skill-directory>/scripts/search-full-text.sh --regex '(?i)^foo'
```

A regular expression is evaluated against each issue field and each comment separately. Lookaheads therefore cannot require one term in the title and another term in a comment. For AND across different fields or comments, run separate searches and intersect issue IDs.

The script prints its working directory and resolved beads database to stderr. Confirm both identify the intended workspace before interpreting the CSV. If either is wrong, stop and rerun from the correct workspace.

If invocation fails with `permission denied`, restore the execute bit once and retry:

```bash
chmod +x <skill-directory>/scripts/search-full-text.sh
```

The script uses `dolt` directly because `bd sql` is not supported in embedded/direct mode. Report its stderr and stop if it exits nonzero.

Interpret the CSV output:

- No rows: report `No matching issues found for: <keywords>`
- Rows found: report count and show the CSV table
- For deep inspection: use `bd show <id>` on specific matches
