---
name: triage-roborev-review
description: Track an enqueued roborev review, triage its findings, and reconcile resolved FAIL reviews and their Beads tasks.
license: MIT
---

# triage-roborev-review

Use this skill for an already-enqueued roborev review. It supports both a
post-commit follow-up with no Beads task and findings recorded in Beads. It
owns assessment, authorized remediation, verification, and reconciliation of
resolved FAIL reviews and their Beads tasks. It does not enqueue a new review
or prescribe the repository's development, testing, formatting, or commit workflow.

Read [references/roborev-beads.md](references/roborev-beads.md) when CLI exit
semantics, integration task recovery, or closure rules are needed.

## Usage

```text
/triage-roborev-review [bd_task_id...]
```

Keep these identifiers paired throughout the work:

| Record | Identifier | Authority |
| --- | --- | --- |
| Beads finding record | task ID | `bd show` |
| Review result | numeric job ID | `roborev show --job` |
| Reviewed code state | full commit SHA | git |
| Follow-up target | HEAD at reviewed commit | `roborev wait HEAD` |

## Workflow

### Entry: Post-commit

After a project-authorized commit that requires roborev confirmation, retain
its full SHA and proceed to **Wait for the current commit**. No Beads task is
required for this entry.

### Entry: Existing findings

From the supplied task IDs, or from relevant open Beads review tasks, run
`bd show` and confirm repository and commit relevance. Extract each task's
exact roborev job ID and pair it with the Beads task ID as an unresolved active
review record. A missing or ambiguous job ID is an inconsistency: report it
without guessing or substituting a new review. Run
`roborev show --job JOB_ID` once for each known job, then proceed to
**Inspect and decide**. If completed findings cannot be retrieved, report the
mismatch or operational error.

### Inspect and decide

Read the cited code and tests, and classify every finding as valid, already
fixed, out of scope, or a reasoned false positive. Ask for the missing design
decision when validity, compatibility, scope, or authorization is unclear.
A false-positive rejection that requires no change does not need a new commit
or follow-up PASS.

### Resolve and verify

Apply only authorized fixes and verify them using the repository's own
instructions. Do not invoke `roborev fix`; keep the assessment and fix context
together. After an authorized fix commit, retain its full SHA and return to
**Wait for the current commit**. If commit authority is unavailable, hand off
the fix and state that follow-up review and reconciliation remain incomplete.

### Wait for the current commit

Keep `HEAD` at the reviewed commit from starting the wait through processing
its result. When the harness provides a resumable or background facility,
prefer it; otherwise, run the wait in the foreground. In either case, run
exactly one:

```bash
roborev wait HEAD
```

Process the output directly as PASS, FAIL, or operational error. If this is a
post-commit entry with no active FAIL records, a PASS is clean: report it and
finish immediately. Do not run `bd list`, `bd show`, `bd create`, `bd comments add`,
or `bd close`, and do not modify or close the passing job. A PASS after fixing
active FAIL records leaves the passing job untouched and proceeds to
**Reconcile and close**. An operational error is reported as incomplete. Do
not search for a follow-up job ID or use another roborev list/show command,
or enqueue a replacement review.

For FAIL, evaluate the findings from the wait output and recover integration
tasks with `bd list --status=open,in_progress --title-contains="Review findings" --limit=0`,
then inspect candidates with `bd show`. Confirm that each task's recorded
commit prefix is a prefix of the known full SHA; do not assume a fixed
short-SHA length. Add the task ID and its recorded job ID to the active
records and claim it when required, then return to **Inspect and decide**.

If the integration task is not immediately present, keep the record unresolved
and reconcile once before finishing; do not poll, create a substitute task, or
use a roborev queue lookup. After another authorized fix commit, return to this
state for one new `roborev wait HEAD` cycle.

### Reconcile and close

A PASS is verification evidence, not automatic closure. For every active
record, require all findings to be fixed or supported by a documented
rejection, required verification to be complete, and closure authorization.
Then comment on and close each resolved FAIL review, and record the result on
the Beads task before closing it. Use the project's available tooling for the
comment input. Never modify or close the passing follow-up job.

If authorization, verification, task recovery, or a finding is outstanding,
leave the affected records open and report the exact handoff. Finish only when
all active records are reconciled and the authorized bookkeeping is complete.
