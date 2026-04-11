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

`$0` is the keyword or phrase. Pass `--open` to restrict results to non-closed issues.

Use `dolt` directly on the beads data directory. Do **not** use `bd sql` here, because `bd sql` is not supported in embedded/direct mode.

If `$0` appears truncated (e.g., user typed `PR #1234` but `$0` is just `PR`), infer the full intended keyword from the original user message and use that.

## Step 1 — Resolve database

```bash
BEADS_DIR=$(bd info | awk -F': ' '/^Database:/{print $2}')
DB=$(dolt --data-dir "$BEADS_DIR" sql -q "SHOW DATABASES" -r csv 2>/dev/null \
  | awk -F, 'NR>1 && $1 !~ /^(dolt|mysql|information_schema)$/ {print $1; exit}')
```

Validate both variables:
- if `BEADS_DIR` is empty, stop and report that beads DB path could not be determined
- if `DB` is empty, stop and report that target Dolt database could not be determined

## Step 2 — Escape keyword and run query

Set `RAW_KW` to the intended keyword (after any `#123` reconstruction), then escape:

```bash
KW=$(printf '%s' "$RAW_KW" \
  | sed -e 's/\\/\\\\/g' -e "s/'/''/g" -e 's/%/\\%/g' -e 's/_/\\_/g')
```

Run:

```bash
dolt --data-dir "$BEADS_DIR" sql -r csv -q "
SELECT
  i.id,
  LEFT(i.title, 60)       AS title,
  i.status,
  i.priority,
  i.issue_type            AS type,
  DATE(i.updated_at)      AS updated,
  CASE
    WHEN i.title        LIKE '%${KW}%' ESCAPE '\\\\' THEN 'title'
    WHEN i.description  LIKE '%${KW}%' ESCAPE '\\\\' THEN 'description'
    WHEN i.notes        LIKE '%${KW}%' ESCAPE '\\\\' THEN 'notes'
    WHEN i.close_reason LIKE '%${KW}%' ESCAPE '\\\\' THEN 'close_reason'
    ELSE 'comment'
  END AS matched_in
FROM ${DB}.issues i
WHERE i.id IN (
  SELECT DISTINCT i2.id
  FROM ${DB}.issues i2
  LEFT JOIN ${DB}.comments c ON i2.id = c.issue_id
  WHERE i2.title        LIKE '%${KW}%' ESCAPE '\\\\'
     OR i2.description  LIKE '%${KW}%' ESCAPE '\\\\'
     OR i2.notes        LIKE '%${KW}%' ESCAPE '\\\\'
     OR i2.close_reason LIKE '%${KW}%' ESCAPE '\\\\'
     OR c.text          LIKE '%${KW}%' ESCAPE '\\\\'
  <STATUS_FILTER>
)
ORDER BY i.updated_at DESC
"
```

`<STATUS_FILTER>` is a placeholder for you (the agent) to replace before
running the query — it is not valid SQL as written.

If `--open` was passed, replace `<STATUS_FILTER>` with:

```sql
  AND i2.status != 'closed'
```

Otherwise remove `<STATUS_FILTER>` entirely (including the line).

## Step 3 — Interpret

- No rows: report `No matching issues found for: <keyword>`
- Rows found: report count and show the CSV table
- For deep inspection: use `bd show <id>` on specific matches
