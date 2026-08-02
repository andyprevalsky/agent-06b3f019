---
id: 2026-07-21-auto-rca-permission-denials-with-no-required-pr-postcondition
date: 2026-07-21
title: The auto-RCA workflow never granted the Bash commands its own prompt required, and had no PR postcondition, so 32 permission denials reported as a successful run
surface: harness
component: auto-rca-workflow
classification: configuration-error
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: .github/workflows/auto-rca.yml — the Claude action's allowed-command list did not cover the commands the workflow prompt instructs Claude to run
symptoms:
  - 32 command permission denials in the auto-RCA Claude action
  - GitHub Actions reports success while no pull request was created
  - Slack card reads "RCA finished without a PR"
tags:
  - auto-rca
  - github-actions
  - permissions
  - postcondition
  - false-green
sources:
  - PR #827
  - memory:project_agent_failure_alerting
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

The live proof run of the automated RCA workflow
(`https://github.com/Rose-Ai-Labs/rose/actions/runs/29791786840`) finished with
the Claude action reporting success while producing nothing: 32 command
permission denials and no pull request. Slack correctly showed "RCA finished
without a PR", so the only accurate signal was the one furthest downstream.

## Diagnosis

Two configuration defects compounded. First, the workflow's prompt instructs
Claude to gather production evidence, run benchmarks and deploy gates, and
publish a PR — but the job never granted the Bash commands needed to do any of
that, so every attempt was denied. Second, the job had no postcondition: with no
assertion that a PR exists at the end, a run that accomplished zero work exited 0. The generalizable cause is that the prompt's requirements and the sandbox's
grants were maintained independently, and nothing tied job success to the
workflow's actual deliverable.

## Solution

Granted Claude exactly six calls to a checked-in least-privilege RCA command
broker (`scripts/auto-rca-tool`), and routed production evidence, benchmark
execution, deploy gates, draft publishing, and ready-state transitions through
that broker — so the permitted surface is defined in one reviewable place instead
of drifting from the prompt. The GitHub Actions job now fails when Claude
completes without creating a pull request, making the deliverable the success
criterion. Both the permission boundary and the required-PR outcome are cemented
in the semantic deploy gate and validated by
`scripts/tests/auto-rca-workflow.test.sh` and
`scripts/tests/semantic-deploy-gate.test.sh`.

## Human feedback

None recorded.

## Reusable lesson

An automation job must assert its own deliverable as a postcondition — otherwise
a fully permission-denied run exits green and the failure only surfaces in a
downstream notification.
