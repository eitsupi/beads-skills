---
name: add-beads-comment
description: Add Beads comments with safe input selection for literal, file, or expanded content.
license: MIT
---

# add-beads-comment

Use this skill when recording progress, decisions, verification, or corrections
on a Beads issue. Run Beads commands from the repository root and respect the
project's workspace selection.

## Choose the input form

For agent-generated literal text, multiline content, code, or shell-sensitive
text, the safe default is a single-quoted heredoc passed through stdin:

```bash
bd comments add ISSUE_ID -f /dev/stdin <<'BD_COMMENT_EOF'
Comment text here.
BD_COMMENT_EOF
```

The file option is `-f` or `--file`, not `--body-file`. For an existing file,
pass that file with the same option. A safely quoted simple one-line literal
may use positional input. If shell expansion is explicitly needed, use an
expansion-capable input form only after understanding and controlling the
expanded text.

The quoted heredoc is a recommended safe default, not a universal prohibition
on other forms. Choose a delimiter that cannot occur in the comment. Unaware
use of an unquoted heredoc, double-quoted body, `echo`, escaped newline, or
command substitution can change the recorded text.

A successful command does not require a read-back. If the result is ambiguous,
inspect existing comments before retrying so that the same comment is not
duplicated. If a comment is malformed, do not assume it can be edited or
deleted; add a correction comment that explains the change.
