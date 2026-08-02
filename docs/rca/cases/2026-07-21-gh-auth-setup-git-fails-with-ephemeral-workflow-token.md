---
id: 2026-07-21-gh-auth-setup-git-fails-with-ephemeral-workflow-token
date: 2026-07-21
title: Auto-RCA branch pushes used `gh auth setup-git`, which cannot authenticate with the ephemeral workflow token
surface: infra
component: auto-rca-workflow
classification: configuration-error
problem_class: other
first_bad_boundary: the Auto-RCA workflow's git credential setup — `gh auth setup-git` did not produce usable credentials for the ephemeral workflow token
symptoms:
  - "Invalid username or token" at git push in the Auto-RCA workflow
  - preliminary scaffold commit succeeds but the branch is never pushed
  - Auto-RCA run reaches the push step and fails there only
tags:
  - auto-rca
  - github-actions
  - git-credentials
  - gh-cli
  - askpass
sources:
  - PR #830
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production Auto-RCA run
`https://github.com/Rose-Ai-Labs/rose/actions/runs/29804300980` created its
preliminary scaffold commit successfully and then failed _only_ at `git push`
with `Invalid username or token`. Everything before the push worked, so the
failure was isolated precisely to credential handoff. The fallback path and the
mandatory postcondition behaved correctly around that concrete failure.

## Diagnosis

The workflow relied on `gh auth setup-git` to configure git credentials. That
helper does not produce a usable credential for the ephemeral workflow token, so
git presented an empty/invalid username and GitHub rejected the push. The deeper
design problem is that the whole approach pushed the token into git's own
configuration surface — remote URLs and repository config — which is both fragile
and a leak risk, and the two publish paths (Claude-published and fallback RCA
branches) did not share one authenticated path, so a fix in one would not cover
the other.

## Solution

Replaced `gh auth setup-git` with a broker-owned temporary `GIT_ASKPASS` helper
so the token is supplied to git at push time and never written into remote URLs or
repository git config, added origin-repository validation before every push, and
routed both Claude-published and fallback RCA branches through that same
authenticated path. Validated with `scripts/tests/auto-rca-workflow.test.sh`,
`scripts/tests/semantic-deploy-gate.test.sh`, ShellCheck, `bash -n`, and the
prompt/agent approval, workspace-env, and Claude-review-fallback suites.

## Human feedback

None recorded.

## Reusable lesson

Supply CI git credentials through a temporary `GIT_ASKPASS` broker rather than
`gh auth setup-git` or token-bearing remote URLs, and validate the origin repo
before every push.
