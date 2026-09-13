---
title: Roborev and Beads integration notes
---

# Roborev and Beads integration notes

Read this reference only when reconciling a review task or interpreting the
follow-up command. The commands and integration behavior here are operational
knowledge, not the triage skill's core workflow.

## Command semantics

- `roborev show --job JOB_ID` addresses the recorded numeric review job.
- `roborev wait HEAD` waits for the review associated with the current commit;
  its output is the follow-up result to process directly.
- `roborev comment --job JOB_ID --message MESSAGE` records the resolution on a
  resolved FAIL review; `roborev close JOB_ID` closes that review.
- A completed PASS should be treated as successful verification. A completed
  FAIL can return a nonzero status while still containing findings. An
  operational error is not evidence about the code and is report-only.

Do not infer a job from queue order or start a replacement review. A follow-up
does not need a separate job lookup.

## Waiting safely

When the harness offers a resumable or background command facility, use it for
the wait and retain its handle together with the commit mapping. Continue only
independent chat work, without moving `HEAD`, and collect the result from the
same handle. Do not use a bare shell `&` or start a duplicate wait. Without
such a facility, run the wait in the foreground.

## Beads integration recovery

After a FAIL, the integration may create a new review task asynchronously. Use
`bd list --status=open,in_progress --title-contains="Review findings" --limit=0`
to retrieve candidates, then inspect each with `bd show`. A commit prefix
recorded in a task is valid only when it is a prefix of the known full SHA; do
not assume a particular short-SHA length. A task can be delayed or missing
immediately after the follow-up. Keep it unresolved, reconcile once before
finishing, and avoid indefinite polling or creating a substitute task.

## Reconciliation invariants

Comment on a resolved FAIL review before closing it. Record the same decision,
commit, verification, and follow-up result on its Beads task before closing it.
A passing follow-up job is left untouched. Closure requires that every finding
is fixed or justified, verification is complete, and existing closure
authorization applies; a PASS alone does not close records. A clean
post-commit PASS with no active FAIL records is terminal: do not run Beads
commands or modify the passing job. A PASS after fixing active records only
authorizes reconciliation of those records.
