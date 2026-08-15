#!/usr/bin/env bash
# Search every text-bearing beads issue field and its comments.

set -euo pipefail

err() { printf 'search-full-text: %s\n' "$*" >&2; }
usage() {
  err 'usage: search-full-text [--open] [--regex] <search term> [<search term> ...]'
  exit 2
}

open_only=false
regex_mode=false
keyword_parts=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --open)
      open_only=true
      shift
      ;;
    --regex)
      regex_mode=true
      shift
      ;;
    --)
      shift
      keyword_parts+=("$@")
      break
      ;;
    --*)
      err "unknown option: $1"
      usage
      ;;
    *)
      keyword_parts+=("$1")
      shift
      ;;
  esac
done

[ "${#keyword_parts[@]}" -gt 0 ] || usage
for raw_keyword in "${keyword_parts[@]}"; do
  [ -n "$raw_keyword" ] || { err 'keywords must not be empty'; exit 2; }
done

command -v bd >/dev/null 2>&1 || { err 'bd is required'; exit 3; }
command -v dolt >/dev/null 2>&1 || { err 'dolt is required'; exit 3; }

err "working directory: $(pwd -P)"

beads_dir=$(bd info | awk -F': ' '/^Database:/ && !found {print $2; found = 1}')
[ -n "$beads_dir" ] || { err 'beads DB path could not be determined'; exit 4; }
[ -d "$beads_dir" ] || { err "beads DB path does not exist: $beads_dir"; exit 4; }

db=$(
  dolt --data-dir "$beads_dir" sql -q 'SHOW DATABASES' -r csv 2>/dev/null |
    awk -F, 'NR > 1 && $1 !~ /^(dolt|mysql|information_schema)$/ && !found {print $1; found = 1}'
)
[ -n "$db" ] || { err 'target Dolt database could not be determined'; exit 4; }
case "$db" in
  *[!A-Za-z0-9_]*)
    err "target Dolt database has an unsafe identifier: $db"
    exit 4
    ;;
esac
err "beads database: $beads_dir ($db)"

append_or_condition() {
  local variable_name="$1"
  local condition="$2"
  local current_value="${!variable_name}"
  if [ -n "$current_value" ]; then
    printf -v "$variable_name" '%s\n     OR %s' "$current_value" "$condition"
  else
    printf -v "$variable_name" '%s' "$condition"
  fi
}

title_matches=''
description_matches=''
notes_matches=''
close_reason_matches=''
comment_matches=''
inner_title_matches=''
inner_description_matches=''
inner_notes_matches=''
inner_close_reason_matches=''
for raw_keyword in "${keyword_parts[@]}"; do
  if [ "$regex_mode" = true ]; then
    pattern=$(printf '%s' "$raw_keyword" | sed -e 's/\\/\\\\/g' -e "s/'/''/g")
    append_or_condition title_matches "REGEXP_LIKE(i.title, '${pattern}')"
    append_or_condition description_matches "REGEXP_LIKE(i.description, '${pattern}')"
    append_or_condition notes_matches "REGEXP_LIKE(i.notes, '${pattern}')"
    append_or_condition close_reason_matches "REGEXP_LIKE(i.close_reason, '${pattern}')"
    append_or_condition comment_matches "REGEXP_LIKE(c.text, '${pattern}')"
    append_or_condition inner_title_matches "REGEXP_LIKE(i2.title, '${pattern}')"
    append_or_condition inner_description_matches "REGEXP_LIKE(i2.description, '${pattern}')"
    append_or_condition inner_notes_matches "REGEXP_LIKE(i2.notes, '${pattern}')"
    append_or_condition inner_close_reason_matches "REGEXP_LIKE(i2.close_reason, '${pattern}')"
  else
    keyword=$(
      printf '%s' "$raw_keyword" |
        sed -e 's/\\/\\\\/g' -e "s/'/''/g" -e 's/%/\\%/g' -e 's/_/\\_/g'
    )
    append_or_condition title_matches "i.title LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition description_matches "i.description LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition notes_matches "i.notes LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition close_reason_matches "i.close_reason LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition comment_matches "c.text LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition inner_title_matches "i2.title LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition inner_description_matches "i2.description LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition inner_notes_matches "i2.notes LIKE '%${keyword}%' ESCAPE '\\\\'"
    append_or_condition inner_close_reason_matches "i2.close_reason LIKE '%${keyword}%' ESCAPE '\\\\'"
  fi
done

status_filter=''
if [ "$open_only" = true ]; then
  status_filter="  AND i2.status != 'closed'"
fi

query=$(cat <<SQL
SELECT
  i.id,
  LEFT(i.title, 60)       AS title,
  i.status,
  i.priority,
  i.issue_type            AS type,
  DATE(i.updated_at)      AS updated,
  CASE
    WHEN (${title_matches}) THEN 'title'
    WHEN (${description_matches}) THEN 'description'
    WHEN (${notes_matches}) THEN 'notes'
    WHEN (${close_reason_matches}) THEN 'close_reason'
    ELSE 'comment'
  END AS matched_in
FROM ${db}.issues i
WHERE i.id IN (
  SELECT DISTINCT i2.id
  FROM ${db}.issues i2
  LEFT JOIN ${db}.comments c ON i2.id = c.issue_id
  WHERE (
       (${inner_title_matches})
    OR (${inner_description_matches})
    OR (${inner_notes_matches})
    OR (${inner_close_reason_matches})
    OR (${comment_matches})
  )
${status_filter}
)
ORDER BY i.updated_at DESC
SQL
)

dolt --data-dir "$beads_dir" sql -r csv -q "$query"
