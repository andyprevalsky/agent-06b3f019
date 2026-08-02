---
id: 2026-07-22-recovery-compared-against-missing-local-main-ref
date: 2026-07-22
title: Legacy-branch recovery compared against a local `main` ref that Actions checkouts do not have
surface: harness
component: auto-rca-workflow
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Auto RCA recovery path — it diffed recovery branches against `main`, which exists only as `origin/main` in a legacy branch checkout
symptoms:
  - Auto RCA trusted finalizer fails on the recovery-only path
  - recovery branch comparison fails because no local main ref exists
tags:
  - auto-rca
  - git-refs
  - github-actions
  - recovery-path
  - checkout
sources:
  - PR #850
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

After the investigator failure in production canary run 29888707855, the trusted
finalizer hit a _second_, independent failure on its recovery-only path: legacy branch
checkouts have `origin/main` but no local `main` ref, and the recovery comparison
referenced `main`.

## Diagnosis

The recovery code assumed a local `main` branch exists in the working checkout. In a
GitHub Actions checkout of a legacy branch, only the remote-tracking ref is
materialized, so the comparison referenced a ref that was never created and the
finalizer aborted. Because this path only runs during recovery, it was exercised for
the first time by a failure — a rarely-taken branch carrying an assumption the common
path never tested.

## Solution

Recovery branches are now compared against `origin/main`, which is always present in
an Actions checkout, and the behavior is cemented in the workflow and lifecycle tests
so the recovery-only path has coverage independent of an actual incident. Verified
alongside the OIDC fix in the same PR with the full offline gate (27 report domains),
ShellCheck, Actionlint, and the Auto RCA workflow-contract and lifecycle blackbox
suites.

## Human feedback

The administrator explicitly waived only the `claude-code-agent` billing smoke that
had returned "Credit balance is too low", and made clear that no broader test waiver
applied.

## Reusable lesson

In CI, compare against `origin/<branch>` rather than a local branch name, and give
recovery-only paths their own tests — they are otherwise first exercised during an
incident.
