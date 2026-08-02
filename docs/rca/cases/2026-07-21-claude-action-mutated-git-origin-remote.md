---
id: 2026-07-21-claude-action-mutated-git-origin-remote
date: 2026-07-21
title: The Claude action mutated `origin` to a credential-bearing remote, so the RCA broker rejected the push destination
surface: harness
component: auto-rca-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Auto RCA branch publication — it pushed to whatever `origin` currently pointed at, which the Claude action had rewritten
symptoms:
  - Auto RCA run reaches the fallback scaffold commit then fails to publish the branch
  - the broker rejects the configured remote before invoking askpass
tags:
  - auto-rca
  - github-actions
  - git-remote
  - credential-hygiene
  - branch-publication
sources:
  - PR #833
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production Auto RCA run 29806017550 got as far as the fallback scaffold commit and
then could not publish its RCA branch: the run showed that the Claude action had
mutated `origin`, and the trusted verification broker rejected that remote before it
ever invoked the askpass helper.

## Diagnosis

Branch publication trusted the ambient `origin` remote. But the Claude action
temporarily installs its own credential-bearing remote under that name, so by
publication time `origin` was no longer the destination the workflow intended — and
the broker, correctly refusing to push to an untrusted credential-bearing URL,
failed the step. The owned defect is the implicit dependency: the workflow inherited
mutable git state from another action instead of stating its destination explicitly.

## Solution

Immediately before RCA branch publication, `origin` is reset to the validated
`GITHUB_REPOSITORY` HTTPS URL, making the trusted destination explicit rather than
inherited. The ephemeral `GIT_ASKPASS` helper is retained so the token stays out of
URLs and git config. Cemented by `scripts/tests/auto-rca-workflow.test.sh` and
`scripts/tests/semantic-deploy-gate.test.sh`, plus ShellCheck and `bash -n`.

## Human feedback

None recorded.

## Reusable lesson

Never inherit a push destination from ambient git state in CI — re-derive and reset
`origin` from validated environment input right before you push, and keep tokens in
askpass rather than in the remote URL.
