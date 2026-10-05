---
id: 2026-10-05-deploy-fixture-host-deadlines
date: 2026-10-05
title: Deploy process fixtures used host-sensitive completion deadlines
surface: harness
component: deploy-command-fixtures
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: process fixture startup and completion assertions expired before verified cleanup publication completed
symptoms:
  - "proof supervisor did not finish its owned cleanup"
  - "the first gate did not start"
  - "subprocess.TimeoutExpired"
tags:
  - deploy
  - fixture
  - verification
sources:
  - commit 7695d9bd9819c6c8bf3d87ce9c039e3c5535a5a4
repro: scripts/tests/fleet-stability-cleanup.test.py
status: fixed
---

## Problem

The requested fresh deploy gates exposed this fixture defect. Original failed
receipts remain private under `.context/deploy-runs/pr1410-finalize-20261005/`.
They do not receive successful deployment or fleet acceptance credit.

## Diagnosis

The canonical 41-suite deploy run failed six entries. Descend and semantic
reported the same five-second cleanup-fixture expiry. Retained receipts already
proved exact cleanup, drained process groups, and preserved unrelated ownership;
the controller was still publishing its exit. Separate duplicate-frame and SKIPPED controls exceeded an eight-second host
guard in the subsequent clean gate. Their outcome assertions remain intact.
A separate import-only Node child
also exceeded five seconds, and the native runner fixture had five seconds to
observe its first child. These are host observation bounds, not task deadlines.

Archive searches covered fixture host deadlines, simulated review clocks, and
finish/admission state. Similar observer and discarded-inner-evidence cases
were leads; they do not establish this incident's cause.

## Solution

Use sixty-second fixture startup/completion guards while keeping all outcome,
exact-owner cleanup, and failure assertions. Signal-fixture failure cleanup now
asks the still-owned runner to drain its independent child sessions; fallback
signals require current parent/group identity and refuse a reaped parent.
Default structural scheduling is bounded at eight suites, with explicit override;
a deterministic admission control checks the filled batch, all eleven commands
once, and propagation of a real exit-seven failure. This operational admission
policy does not establish the cause of every historical delay.

The canonical command and owning controls are rerun with unchanged semantic
outcome assertions. Product runtime, prompts, evaluators, benchmark definitions,
7200-second normal backstops, and existing 100/50-task evidence are unaffected.
There is no product cost at 10,000 agents. Independent adversarial review checks
actual private failed/green receipts and fixture cleanup ownership.

## Human feedback

The user requested liberal infrastructure observation budgets, compact permanent
deploy regression coverage, and preservation of completed fleet evidence.

## Reusable lesson

Verify the owned outcome with deterministic scenario inputs and generous host observation guards.
