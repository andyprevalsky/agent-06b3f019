---
id: 2026-10-06-seed-preflight-assertion-did-not-follow-extracted-runner
date: 2026-10-06
title: Seed preflight structural assertion searched the controller after its runner moved to a shared helper
surface: harness
component: seed-cache-decision-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the structural assertion required seed GET runner literals in run-bench-fleet after the actual call moved to cloudbench-seed-get.sh
symptoms:
  - run-bench-fleet missing cloud-guest canonical seed-dump preflight
  - seed-cache decision reported 41 passing controls and one failure
tags:
  - seed-cache
  - extraction
  - deployment
sources:
  - PR #1424
repro: scripts/tests/seed-cache-decision.test.sh
status: open
---

## Problem

The deploy structural lane reported one seed-cache-decision failure. The
controller still verified the cloud guest's Postgres-major-specific token,
called the full GET helper, and exited before provisioning on a missing dump.
Its structural assertion nevertheless reported the preflight was absent.

## Diagnosis

The reviewed cohort seed transfer change moved the standalone GET's TypeScript,
Node and tsx runner selection into cloudbench-seed-get.sh. The old assertion
searched only run-bench-fleet for those implementation literals. Its first bad
boundary was the source owner mismatch in that conjunction, not the native
fixture admission or cloud guest restore path.

Archive searches covered seed-cache-decision, missing canonical seed preflight
and host seed GET extraction. The same-day repeated canonical fixture GET case
is the relevant source change; the older stale baked seed-dump case describes
a different cache-decision bug. Neither establishes this stale assertion.

The unchanged 42-control script reproduced 41 PASS and one FAIL in 4.122
seconds. The repaired script passed all 42 controls in 3.799 seconds. The
unchanged existing campaign seed-preflight selection reported four passed tests,
one existing Linux-only skip and five deselected tests in 8.13 seconds
(8.544 seconds of outer wall time). It exercised the actual TypeScript loopback
path, including one full host GET for 50 owned controllers, standalone GET,
missing fixture and foreign proof rejection. The normal deferred Linux status
fixture separately exercises the host-skipped native owner branch.
No paid provider, model, real benchmark or cloud guest was launched.

## Solution

Follow the actual shared GET helper for the original TypeScript, Node and tsx
runner assertions. Bind the controller's guest-major/token/probe arguments,
missing-fixture exit and ordering before provisioning. Reuse the existing
native loopback admission family rather than adding another test family or
placing fake matching literals in the controller.

The structural script and native owning family remain in their normal
registered gates. Independent source review passed; the final normal registered
deployment run is pending, so the case remains open. These controls do not
establish a benchmark verdict, native capacity or a production speedup.

## Human feedback

The user required fast owning regression controls and honest native evidence.
The repair preserves all seed admission and restore requirements and retains
the original failed deployment attempt.

## Reusable lesson

After extraction, structural ownership checks must follow the invoked helper and retain the caller's failure boundary.
