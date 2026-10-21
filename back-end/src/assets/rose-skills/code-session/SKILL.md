---
name: code-session
description: Use when you work in a repository (branches, commits, merges) and to know what survives a pause, a retry or a usage limit.
---

# Your code session

## Persistence

This session is persistent. Your files, local commits and conversation are
kept between turns and sessions: the sandbox pauses instead of being deleted,
and a retry resumes it where it stopped.

## Branches

- You work on your own branch. Your instructions name it and its merge
  target.
- Each independent agent has its own Git branch and worktree. A top-level
  agent branches from the project's shared default branch. A sub-agent's
  branch is stacked on its parent's exact current commit and its PR targets
  that parent branch. Record the fork commit; do not substitute the remote
  default branch for the parent's in-progress work.
- When the parent advances, integrate its new head through the repo workflow
  and revalidate before joining. Internal coding helpers that share a worktree
  also share its checked-out branch; independent branches need separate worktrees.

## Commits and network publication

- Commit locally whenever a unit of work is complete. Commits are your
  checkpoints; a local commit is not publication to the network.
- Independent sub-agents of sub-agents use the branch-join skill to join the
  immediate parent branch. Internal coding workers share the owning coding
  agent's worktree and coordinate edits instead of merging separate branches.
- To publish top-level changes to all agents in the network, use the repository's own deploy skill
  to integrate the validated change into GitHub `main` (or the repository's
  configured shared default branch).
- Read the installed deploy skill for discovery and fallback creation when
  the repository has no deploy skill. Do not substitute a direct push for the
  repository's tests, reviews, approvals, and deployment process.
- Coordinate with the current deploy owner instead of racing another agent's
  release. Preserve other agents' changes and resolve integration conflicts.
- Return the verified merged commit, branch, checks, and deployment outcome to
  the parent. An open PR, local merge, or push to your private branch is not a
  network publication. Running agents adopt the published revision at a safe
  synchronization point; do not overwrite their dirty worktrees.
<!-- rose-desktop -->
- When the checkout is Rose itself, use its existing `/deploy` workflow and
  whole-devbox coordinator. Do not create a competing deploy skill or bypass
  its required checks and outstanding approvals.
<!-- /rose-desktop -->

## Usage limits

If the coding agent's usage limit is reached mid-task, Rose checkpoints this
session (branch, commits and uncommitted files), pauses it and tells the
agent that started you to retry. The retry may run on the other coding
agent; its first message then begins with a handoff summary of this
conversation. Continue from the files and commits that are already here.
Never start over.

## When not to use

- Without a repository there is nothing to commit or merge: follow the file
  contract in your instructions.
