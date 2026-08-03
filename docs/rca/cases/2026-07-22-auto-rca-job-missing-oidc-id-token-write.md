---
id: 2026-07-22-auto-rca-job-missing-oidc-id-token-write
date: 2026-07-22
title: The Auto RCA job lacked `id-token: write`, so both Claude investigator attempts failed unauthorized
surface: harness
component: auto-rca-workflow
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Auto RCA workflow job permissions — no `id-token: write`, so GitHub OIDC was unavailable to the investigator
symptoms:
  - both Claude investigator attempts fail in an Auto RCA run
  - Auto RCA run ends red with the PR left as a draft and Slack transitioned to blocked
tags:
  - auto-rca
  - github-actions
  - oidc
  - permissions
  - workflow-contract
sources:
  - PR #850
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production canary run 29888707855 correctly reused PR #836 and its existing Slack
card, but both Claude investigator attempts failed. The run failed closed: PR #836
stayed a draft, the Slack card transitioned to blocked, and the workflow remained
red.

## Diagnosis

The Auto RCA job did not grant `id-token: write`, so no GitHub OIDC token was
available and the investigator could not authenticate — every attempt failed for the
same reason, which is why a retry did not help. The workflow contract assumed an
authorization the job never requested; nothing about the investigation logic was
wrong.

## Solution

Granted GitHub OIDC (`id-token: write`) to the Auto RCA job, and cemented the
permission as a contract in the workflow and lifecycle tests so a future workflow
edit cannot drop it silently. Verified with the full offline gate (all 27 report
domains via `bash scripts/test.sh --no-smoke`), backend blackbox 96/96, agents
blackbox 86/86, ShellCheck and Actionlint, and the Auto RCA workflow-contract and
lifecycle blackbox suites. The post-merge canary reuses the same PR and Slack card to
prove OIDC authorization end to end.

## Human feedback

The administrator explicitly waived only the `claude-code-agent` billing smoke that
had returned "Credit balance is too low", and made clear that no broader test waiver
applied.

## Reusable lesson

When every attempt of a CI sub-job fails identically, check the job's declared
`permissions` before debugging the tool — a missing `id-token: write` makes OIDC
authentication impossible and retries pointless.
