---
id: 2026-10-17-capacity-timeout-covered-local-archive-proof
date: 2026-10-17
title: Native capacity timeout also covered complete local archive validation
surface: infra
component: run-original600-controller
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the native capacity deadline enclosed local archive hashing
symptoms:
  - external controller I/O deadline while hashing recovered archive membership
  - complete standalone preparation passed but normal admission stopped
  - no reservation request or controller was created
tags:
  - cloudbench
  - admission
  - timeout
  - archive
sources:
  - commit 59ab01b35aa91521e105a3d48e1587007aa347ad
  - fleet run original600-1792263746104190724
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/original600-portable-operator.test.py
status: open
---

## Problem

The complete standalone preparation validated 553 candidates. Normal run73
admission then stopped before reservation, despite unchanged inputs. Its
110-second capacity timer covered both the organization-wide native reads
and the subsequent complete local archive proof. The retained traceback
ended in recovered membership hashing, rather than in a provider call.

## Diagnosis

`capacity()` first collected native capacity and then called the full reuse
preparation. `main()` wrapped that entire call in the native I/O deadline.
The recovered archive was about 900 MB; its complete membership and ancestry
checks legitimately performed more local work than that network deadline
allowed. The failed admission retained its original intent, native read
snapshots and process stream, with no reservation or launch artifacts.

Archive search terms were `capacity deadline`, `deadline capacity` and
`local proof`. The related post-canary inventory case concerns missing fresh
capacity evidence; it does not cover this mixed timing scope.

## Solution

Bound the native snapshot separately at 110 seconds. Bound local preparation
by the remaining original admission deadline, and recheck that deadline
before reservation. Preserve the existing post-reservation fresh snapshot
and final capacity freshness checks.

For the already-started admission, a separate preparation-only operator must
validate the joined failure, unchanged original source and inputs, complete
old file membership and absence of reservation or launch. It publishes the
first canonical request only after the complete proof succeeds. The original
unchanged operator can then resume its normal reservation and launch path
with the original epoch. This stage grants no reservation or task credit.

The owning clock control allows local proof longer than 110 seconds, still
rejects a native read longer than 110 seconds, and rejects local proof that
exceeds the original admission deadline. Actual same-admission continuation
remains required before this case can close.

## Human feedback

Keep the original600 workload, original clock, resource protections and
retained failures. Complete the authorized work through the canonical path;
do not discard an admission or obtain a new time budget to hide the failure.

## Reusable lesson

A network deadline should bound the network operation. Local verification
still needs a finite budget, but it must use the enclosing operation's real
deadline rather than silently consuming a smaller transport allowance.
