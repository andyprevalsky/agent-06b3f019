---
name: branch-join
description: Use when an independent nested agent must integrate its work into its immediate parent's assigned branch.
---

# Join the immediate parent branch

Independent sub-agents of sub-agents return their changes to the immediate
parent's assigned branch, not directly to `main`. Confirm that target from the
session's branch facts or parent assignment; never guess it from a branch name.
Work on an independent branch and worktree stacked on the parent's recorded
commit. The PR base is the parent branch, not the shared default branch. If the
parent advances, integrate that head and rerun the affected checks before join.
Never switch a shared worktree to a competing agent's branch.
Read the repository's own branch-join skill if it has one, then follow its
checks, conflict handling, and merge workflow.

If no branch-join skill exists, use the deploy skill with **parent-branch join**
as the operation and the immediate parent's branch as the explicit target.
Reuse its discovery and validation process, but do not perform a main-branch
merge or production rollout. If that workflow only supports `main`, add a
repo-local branch-join adapter using its validation commands and the correct
parent target; do not invent an unsupported deploy CLI flag.

Commit the assigned changes, coordinate with the parent, and merge against its
current head. Resolve conflicts without discarding parent or sibling work.
Return the before/after parent commit, applied child commit, and check results.
An open PR is not a completed join. Retries must recognize an already-applied
commit. Network-wide publication is the top-level owner's later deploy step.

## Internal coding workers

A coding agent's internal workers operate in that coding agent's same worktree
unless the user or repository explicitly requests isolation. They do not need
a branch join. Assign nonoverlapping files or serialize overlapping edits;
let the owning coding agent coordinate commits, checkout/rebase, and publication.
Sharing a worktree does not make simultaneous Git mutations safe. Do not launch
another code-agent CLI merely to manufacture an internal worker.
