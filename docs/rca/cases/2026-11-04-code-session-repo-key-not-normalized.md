---
id: 2026-11-04-code-session-repo-key-not-normalized
date: 2026-11-04
title: Code-session repo key was only trimmed, so ".git" and trailing-slash URL variants forked a new session on a new branch
surface: back-end
component: code-session-store
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/store.ts repoKeyFor returned repoUrl.trim()
symptoms:
  - Created code session instead of Resuming code session for the same repository
  - new branch rose/... for the same repo after the URL gained .git
  - code agent loses its worktree when repo_url is written as https://github.com/o/r.git
tags:
  - code-sessions
  - repo-key
  - input-normalization
sources:
  - commit a3f8dd421c
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

A session's identity is `(userId, ownerAgentId, repoKey)`. `repoKeyFor` only
trimmed whitespace, so `https://github.com/o/r`, `https://github.com/o/r.git` and
`https://github.com/o/r/` were three repositories. A planner or user that wrote
the URL differently on a later spawn started a fresh session on a new branch,
without the previous worktree.

## Diagnosis

`store.ts:52-54` at base 28a7bfc99. Repro (buggy base):
`cd back-end && bash scripts/run-blackbox-tests.sh code-sessions` →
`not ok 26 - repo URL variants (.git suffix, trailing slash) resolve to the same code session`
(the expected and actual session ids differ).

## Solution

`repoKeyFor` normalizes at the one place every session lookup derives its key
(store resolve, `ownerCodeSessions`, `branch.ts`, `rootPreviewRepo.ts`). It trims,
strips trailing slashes and strips a `.git` suffix. `repoUrl` itself is stored
unchanged. Existing rows keyed with a suffixed URL fork once more on their next
spawn; this repo is pre-launch and has no compatibility obligation.

10k agents: string normalization only.

Post-fix: same command passes; 5/5 consecutive runs.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Normalize an external identifier at the single function that derives the lookup key, so every reader and writer agrees on identity.
