---
name: triage-roborev-review
description: >
  Triage roborev review tasks tracked in beads (bd). Discovers open review
  tasks, shows findings, fixes code or explains why a finding is skipped,
  then closes both the roborev review and the bd task. Consults the user
  for decisions that require judgement.
compatibility: Requires the beads CLI (`bd`), the roborev CLI, git, and access to the target project workspace. Verification commands depend on the project's toolchain.
license: MIT
---

# triage-roborev-review

Triage and resolve roborev review findings tracked as beads tasks.

## Usage

```
/triage-roborev-review [bd_task_id...]
```

## IMPORTANT

These instructions are guidelines, not a rigid script. Use the
conversation context. Skip steps that are already satisfied. Defer to
project-level instructions when they conflict with these steps.

## Instructions

### 1. Discover review tasks

**If bd task IDs are provided**, fetch each one with `bd show <id>`.

**If no IDs are provided**, discover open review tasks:

```bash
bd list --status=open | grep -i review
```

If nothing is found, inform the user there are no review tasks.

### 2. Extract roborev job IDs

Parse the bd task title or description for the roborev job ID. The
convention is: the title contains `roborev show <job_id>` or
`roborev fix <job_id>`.

If the job ID cannot be determined from the bd task, ask the user.

### 3. Fetch review findings

For each job ID:

```bash
roborev show <job_id>
```

Present the findings to the user with a brief summary of:
- Number and severity of findings
- Which files are affected
- Your recommended action for each finding (fix / skip with reason)

### 4. Consult the user

**Do not proceed with fixes without the user's approval.** Present your
plan and wait for confirmation. The user may:
- Approve all fixes
- Skip specific findings
- Provide additional context or constraints
- Ask you to investigate further
- Defer the review (e.g. it belongs to a different branch/scope)

**IMPORTANT**: "Skip" or "not relevant" does NOT mean "close". The user
may want to leave the task open for another session or agent to handle.
Never close roborev reviews or bd tasks without **explicit** user
confirmation — even if the user says to skip or ignore a finding.

### 5. Fix approved findings

For each approved finding:
1. Read the relevant code
2. Apply the fix
3. Run the project's formatter or linter, if available
4. Run relevant tests or other project-specific verification

Group changes by file to minimize context switches. Fix high-severity
issues first.

### 6. Commit

Follow the project's commit conventions. Commit the
fixes and report the commit SHA.

**IMPORTANT**: Always create a **new** commit — never amend a previous
commit. Roborev job IDs are tied to the commit SHA that triggered the
review. Amending changes that SHA, which breaks the traceability chain
and requires a force push.

### 7. Close reviews and tasks

**Ask the user for explicit confirmation before closing.** Do NOT infer
closure from skip/defer decisions — always ask separately. Then:

```bash
# Close roborev review
roborev comment <job_id> "<summary of changes>"
roborev address <job_id>

# Close bd task
bd close <bd_task_id> --reason="<reason>"
```

If multiple reviews were triaged, close them all.

## Examples

**Auto-discovery:**

User: `/triage-roborev-review`

Agent:
1. Runs `bd list --status=open | grep -i review` and finds task `dd99`
2. Extracts job ID `389` from the task title
3. Runs `roborev show 389` and presents 2 findings (Medium + Low)
4. Proposes: fix the Medium finding, skip the Low with reasoning
5. Waits for user approval
6. Fixes the Medium finding, commits
7. Asks user to confirm closing
8. Closes roborev review 389 and bd task dd99

**Explicit task IDs:**

User: `/triage-roborev-review dd99`

Agent:
1. Runs `bd show dd99` to get task details
2. Extracts job ID, fetches review, proceeds as above
