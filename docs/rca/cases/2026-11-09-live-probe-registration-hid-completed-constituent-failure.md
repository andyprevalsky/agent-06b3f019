---
id: 2026-11-09-live-probe-registration-hid-completed-constituent-failure
date: 2026-11-09
title: live probe registration hid completed constituent failure
surface: infra
component: deploy-live-probes
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: live-probe planner registered only an opaque aggregate
symptoms:
  - UNVERIFIED live-probes
  - live GLM failover must escalate the exact prod follow-up
tags:
  - deploy
  - native-evidence
sources:
  - PR #1881
  - commit ac528ddae20f5da7fb9069d4778f024315047bf5
repro: scripts/tests/deploy-live-probes.test.py
status: fixed
---

# live probe registration hid completed constituent failure

## Problem

The original aggregate was UNVERIFIED although all four probes completed; the exact chat-router failover assertion failed while three peers passed.

## Diagnosis

The generic runner correctly refuses to infer completeness from an aggregate nonzero exit. The live gate lacked native constituent registration. Registration causal replay exited 1 on the old planner and 0 on the repaired planner. The original product failure remains NOT_INTRODUCED; no provider outage is inferred.

## Solution

Retain the original aggregate contract, register four native constituents and execute them once with the original concurrency and amplitude-before-chat dependency. Native complete FAIL remains FAIL; exit 2, interruption and unknown cleanup remain UNVERIFIED. Eleven tests passed five times; parent reviewed the disjoint execution and unchanged contracts. Included in PR #1881; production deployment remains the parent deploy's separate obligation. At 10k agents these coordinator-only changes add no per-agent query, subscription or shared runtime bottleneck.

## Human feedback

None recorded.

## Reusable lesson

Register native constituent evidence before using an aggregate test result for deployment attribution.
