---
name: triage-roborev-review
description: >
  Triage roborev findings tracked as beads tasks. Use when a coding agent
  should inspect earlier review findings against the code, resolve accepted
  findings, and follow the post-commit review through completion. Do not use
  this skill merely to start a new review.
license: MIT
---

# triage-roborev-review

Use one coding agent to evaluate roborev findings against the current code,
carry the accepted fixes through verification, and inspect the follow-up review
without losing context.

Requires the beads CLI (`bd`), the roborev CLI, git, and access to the target
project workspace. Verification commands depend on the project's toolchain.

## Usage

```text
/triage-roborev-review [bd_task_id...]
```

Treat this as a context-sensitive workflow rather than a rigid script. Skip
work that is already complete, honor project-level instructions, and do not
infer permission to commit, enqueue reviews, or close records.

## Keep identifiers distinct

A beads task ID, roborev job ID, and Git commit SHA are different identifiers.
Never pass one where another is expected.

- `bd show <bd_task_id>` accepts a beads task ID. It has no `--job` flag.
- `roborev show --job <job_id>` forces a numeric argument to be a roborev job
  ID instead of a Git ref.
- `roborev wait --job <job_id>` waits for an existing roborev job. It does not
  enqueue a review.
- `roborev comment --job <job_id> --message <message>` records a job comment.
- `roborev close <job_id>` accepts a job ID directly and has no `--job` flag.
- `roborev fix <job_id>` accepts job IDs directly and has no `--job` flag.

Prefer the explicit `--job` form wherever roborev provides it. A numeric Git
ref can otherwise be mistaken for a job ID or vice versa.

## Workflow

### 1. Discover earlier review findings through beads

If the user supplied beads task IDs, inspect each with:

```bash
bd show <bd_task_id>
```

Otherwise, use `bd list` to find outstanding review tasks, including work that
another session already claimed:

```bash
bd list --status=open,in_progress --title-contains="Review" --limit=0
```

Inspect each candidate with `bd show`. The beads queue is the source for
earlier unresolved findings; do not look only at the review for `HEAD`. If the
search finds no relevant task, report that result and stop.

Before editing, confirm that each task belongs to the current repository and
that its reviewed commit is relevant to the current branch or worktree. Do not
overwrite unrelated user changes or take over another active owner's task
without authorization. Claim a task before working on it when the project's
beads workflow requires that.

### 2. Resolve the roborev job ID

Extract the numeric job ID from the task title or description. Integration
tasks commonly contain either `roborev show <job_id>` or
`roborev show --job <job_id>`, and may also advertise
`roborev fix <job_id>`. Treat the `roborev fix` text as a convenience offered by
the integration, not as an instruction to run it.

If a task says `Review failed`, or the job ID is absent or ambiguous, do not
guess and do not enqueue a replacement review. Use the commit SHA and
`roborev list --json` to resolve an exact existing job when possible; otherwise
report the mismatch and ask the user how to handle the beads task.

### 3. Inspect the review and the code

For a completed job, fetch the authoritative result with:

```bash
roborev show --job <job_id>
```

If the job is still queued or running, wait for that exact existing job instead
of polling `roborev list` or `roborev show`:

```bash
roborev wait --job <job_id>
```

When the execution environment supports background commands or resumable
command sessions, use that facility for `roborev wait --job`. Keep whatever
execution handle the environment provides and the job-to-commit mapping,
continue other independent work, and collect the result from that same command
when completion is reported. Prefer the environment's supported mechanism over
a bare shell `&`, so the exit status and output are not lost. Do not start
duplicate waits for the same job. If no such facility exists, let
`roborev wait` block in the foreground.

`roborev wait` exits with status 1 for a completed FAIL verdict as well as for
operational errors. A FAIL verdict normally means there are findings to
triage, so after the wait completes inspect the result with:

```bash
roborev show --job <job_id>
```

For every finding, the coding agent should read the cited code and relevant
tests or commit diff, then decide whether the finding is still valid. Present a
compact assessment containing:

- severity and affected location
- why the finding is valid, invalid, already fixed, or out of scope
- the recommended fix, rejection rationale, or deferral
- the verification needed for an accepted fix

Do not accept a finding merely because roborev reported it. Equally, do not
dismiss it without checking the actual code and behavior.

If the review passed with no findings, no triage action is required. Note the
outcome briefly, do not comment on or close the passing roborev job, and proceed
to the next discovered review task or other authorized work. If an associated
beads task remains, treat it as a separate administrative record and apply the
project's existing closure authorization without holding up independent work.

### 4. Resolve judgement with the user

Use any explicit decisions already given in the conversation. Otherwise, ask
before making a change when validity, scope, compatibility, or design requires
judgement. The user may accept, reject, defer, or request more investigation
for each finding.

Rejecting, skipping, or deferring a finding does not itself authorize closing
the roborev job or beads task. Record durable reasoning in beads comments when
the project uses comments for work history.

### 5. Implement and verify accepted findings

For each accepted finding:

1. Apply the smallest complete fix consistent with the surrounding design.
2. Add or update a regression test when it materially protects the behavior.
3. Run targeted formatting, linting, and tests, followed by the project's
   broader quality gate when appropriate.
4. Re-read the diff and confirm that it addresses the finding without
   incorporating unrelated changes.

Keep the coding agent in this workflow responsible for the fix. Do not invoke
`roborev fix` by default: it launches a separate agent, commits its changes,
and closes the review, bypassing this workflow's continuous context and
explicit closure decision. Use it only when the user specifically requests
that automation.

### 6. Commit and wait for the follow-up review

Commit only when the user or project workflow authorizes it. Follow project
commit conventions and create a new commit; never amend the commit associated
with the original review job.

When a post-commit hook enqueues a follow-up review, capture its exact numeric
job ID from the hook output or resolve the job that matches the new commit SHA.
Do not choose a job merely because it is the newest when concurrent reviews may
exist. Start a wait for that exact job using the execution environment's
background or resumable-session facility when available:

```bash
roborev wait --job <follow_up_job_id>
```

When that command completes, inspect the result:

```bash
roborev show --job <follow_up_job_id>
```

Use `roborev wait --job` instead of repeated `list` or `show` polling. Because
`wait` only waits for an existing job, a not-found result is not permission to
run `roborev review`; report the missing post-commit job unless the user has
authorized enqueueing one.

Inspect the follow-up output even when `wait` exits nonzero. If it contains new
findings, keep the same coding-agent context and return to the assessment step.
Do not hand the loop to `roborev fix` merely because another iteration is
needed.

If the follow-up review passes, do nothing to that passing job and do not stop
to request a decision about it. Use the PASS as verification evidence for the
original findings, finish any already-authorized bookkeeping for the original
roborev jobs and beads tasks, and continue to the next review task or other
authorized work. If closure of an original record is not authorized, report
that remaining administrative action without blocking independent work.

### 7. Record and close resolved work

Close only when the user has explicitly authorized closure in the current
conversation. An earlier direct instruction to fix and close is sufficient;
do not ask redundantly. Otherwise, fixing or rejecting a finding does not imply
closure.

Before closing a non-passing original review, leave a useful record of what was
changed or why the finding was rejected, then use the canonical close command:

```bash
roborev comment --job <job_id> --message "<resolution_summary>"
roborev close <job_id>
```

Comment before closing. `roborev address` may exist as an alias, but prefer the
documented `roborev close` command. Do not close a passing follow-up review.

Add a beads comment summarizing the decision, changed commit if any,
verification, and follow-up review result. Then close the corresponding task
separately:

```bash
bd close <bd_task_id> --reason="<reason>"
```

When handling multiple tasks, preserve the job-to-task mapping and close only
the pairs whose findings are fully resolved and authorized for closure.
