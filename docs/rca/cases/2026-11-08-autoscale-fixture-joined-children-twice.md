---
id: 2026-11-08-autoscale-fixture-joined-children-twice
date: 2026-11-08
title: Merged autoscale fixture joined its children twice
surface: harness
component: cloudbench-autoscale-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/tests/cloudbench-acceptance-autoscale.test.sh generated finalization harness
symptoms:
  - A successful finalization fixture exited 5 because wait reported a saved PID was not its child
  - finalization harness exited 5
tags:
  - deploy-validation
  - merge-composition
  - regression
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: scripts/tests/cloudbench-acceptance-autoscale.test.sh
status: fixed
---

## Problem

A successful finalization fixture exited 5 because wait reported a saved PID was not its child.

Critical path: native child completion → finalization marker → bare wait → EXIT reaper → suite verdict.

## Diagnosis

A merge combined the upstream bare wait with the branch’s EXIT reaper. The first join discarded child statuses; the reaper waited the same saved PIDs again and converted the not-child failure to exit 5. The production finalization helpers were byte-identical across the compared source boundaries.

The unchanged autoscale suite reproduced the native wait/not-child failure under the canonical supervisor. Removing only the redundant bare wait made the identical command pass. The original marker, elapsed bound, early assertion exit 3, and late child exit 7 mapped to 5 controls stayed intact. Both receipts were quiescent, without orphans, TERM, KILL or remaining children.

The original full-gate UNVERIFIED results remain unchanged. Owning results prove
these repairs only; the new committed source still requires normal gate validation.
Private RED/GREEN and supervisor receipts are retained in round48-operational-owning.

## Solution

Keep the EXIT reaper as the sole join and status owner, on normal and exceptional paths. No production helper, sleep, polling interval, assertion or timeout changes.

## Human feedback

Finish the whole-devbox release and ordinary phone/Google acceptance. Preserve
all original failures and checks, Freedom, phone state, and production environment;
never use a diagnostic pass as production or whole-gate acceptance.

## Reusable lesson

One process owner must join each child and preserve its status; composing two individually valid cleanup strategies can invalidate ownership.
