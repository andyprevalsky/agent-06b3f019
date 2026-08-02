---
id: 2026-07-25-rca-agent-edited-workflow-files-pat-lacks-workflow-scope
date: 2026-07-25
title: Auto-RCA agent edited .github/workflows/** and the push PAT lacked `workflow` scope
surface: harness
component: auto-rca-workflow
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: checkpoint_draft pushed agent edits to .github/workflows/** with GH_UPDATE_TOKEN
symptoms:
  - '"! [remote rejected] … without workflow scope" on the auto-rca push'
  - Finalize PR + Slack update steps fail after a successful RCA
  - recurring hard block across multiple auto-rca runs
tags:
  - auto-rca
  - github-actions
  - permissions
  - pat-scope
  - push-rejection
sources:
  - PR #896
  - commit cd83b5101
  - memory:project_agent_failure_alerting
repro: none-recorded
status: fixed
---

## Problem

Auto-RCA runs that produced a valid diagnosis still failed at push time with
`! [remote rejected] … without workflow scope`. The failure recurred across
multiple runs, blocking the Finalize PR and Slack update steps.

## Diagnosis

The RCA agent, doing exactly what it was told (fix whatever it finds), edited
`.github/workflows/auto-rca.yml` itself. GitHub refuses any push that modifies
files under `.github/workflows/**` unless the credential carries the `workflow`
scope, and `GH_UPDATE_TOKEN` is a PAT without it. Nothing in the harness
prevented the agent from staging files it structurally could not push, so a
correct RCA became an unrecoverable push failure. The deeper cause is a missing
invariant between what the agent is allowed to write and what its push
credential is allowed to carry — widening the token scope was not desirable,
since the fleet deliberately unsets `GITHUB_TOKEN` (`cloudbench-run.sh:241`) so
live push credentials cannot leak into spawned agents.

## Solution

PR #896 makes `checkpoint_draft` discard workflow-file edits before commit and
push, so the agent can never produce an unpushable commit. Verified green on real
run 30170612351 (Finalize PR + Slack update both pass). The alternative — adding
`workflow` scope to the PAT — was rejected as a credential-blast-radius
increase.

## Human feedback

None recorded.

## Reusable lesson

Constrain what an autonomous agent may write to exactly what its push credential
may carry — strip out-of-scope paths in the harness rather than widening the
token.
