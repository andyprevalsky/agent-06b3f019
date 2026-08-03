---
id: 2026-07-21-default-workflow-token-cannot-create-pull-requests
date: 2026-07-21
title: Auto-RCA's draft PR failed because the default workflow token is not permitted to create pull requests
surface: infra
component: auto-rca-workflow
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the auto-RCA `gh pr create` step — it ran with the restricted default GITHUB_TOKEN
symptoms:
  - "GitHub Actions is not permitted to create or approve pull requests"
  - auto-RCA pushes the RCA branch successfully then fails at PR creation
  - auto-RCA workflow reports success even though no draft PR exists
tags:
  - github-actions
  - auto-rca
  - token-scope
  - gh-cli
  - draft-pr
sources:
  - PR #834
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production run
`https://github.com/Rose-Ai-Labs/rose/actions/runs/29807642577` proved
authenticated branch publication succeeded, and then GitHub rejected PR creation
by the restricted default workflow token with `GitHub Actions is not permitted to
create or approve pull requests`. The auto-RCA lifecycle therefore produced no
draft PR.

## Diagnosis

Pushing a branch and opening a pull request need different permissions, and the
default workflow token has the former but is blocked from the latter at the
GitHub-Actions policy level — no workflow-level `permissions` grant can enable it.
The workflow assumed one credential covered the whole lifecycle. Repository
secret inventory confirmed a PR-capable `GH_UPDATE_TOKEN` already existed for
privileged update workflows, so the capability was present but never wired to this
step. A second, compounding defect: the model process was treated as terminal for
lifecycle success, so the run's outcome did not actually depend on the draft PR
existing.

## Solution

Scope the existing PR-capable `GH_UPDATE_TOKEN` to the trusted fallback step only
— never exposed to Claude — and use it solely for `gh pr create`, while the
default workflow token continues to push the RCA branch. Made the model process
non-terminal so the enforced draft PR/postcondition determines lifecycle success,
and made the workflow refuse to attempt PR creation when the required token is
unavailable (fail closed instead of silently green). Validated with
`scripts/tests/auto-rca-workflow.test.sh`,
`scripts/tests/semantic-deploy-gate.test.sh`, ShellCheck, `bash -n`, YAML parse,
and the prompt/agent approval guards.

## Human feedback

None recorded.

## Reusable lesson

Grant a workflow the narrowest PR-capable token only at the step that creates the
PR, and make the postcondition (the PR exists) decide success — the default
GITHUB_TOKEN can push branches but is policy-blocked from opening pull requests.
