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
- A new agent's branch is cut from the project's default branch and merges
  into it. A sub-agent's branch is cut from its parent's branch and merges
  back into it.

## Commits and merges

- Commit locally whenever a unit of work is complete. Commits are your
  checkpoints.
- Merge into your merge target when other agents or the user need your
  changes. Otherwise keep the work on your branch.
- You decide when to commit, push and merge, based on the task.
- If a rebase or merge is required, resolve it before finishing.
<!-- rose-desktop -->
- When your instructions say the checkout is Rose itself, never merge, push
  to main or deploy: open a pull request instead (apps-preview skill).
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
