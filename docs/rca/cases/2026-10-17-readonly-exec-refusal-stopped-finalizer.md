---
id: 2026-10-17-readonly-exec-refusal-stopped-finalizer
date: 2026-10-17
title: A read-only native exec refusal ended monitoring without a safe continuation
surface: infra
component: cloudbench-controller-payload-finalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: machine_control classified a native PROBE transport refusal as an invalid supervisor acknowledgment
symptoms:
  - ValueError exact supervisor exec failed
  - No child process (os error 10)
  - prior finalizer exists reconcile receipts never relaunch effects
tags:
  - cloudbench
  - finalization
  - read-only-recovery
sources:
  - commit 2bacd15761af82b3b5112df7daf84b621adf2109
  - fleet run original600-1792228733439245508
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-controller-payload-finalization.test.py
status: fixed
---

## Problem

The run70 finalizer exited on a native exec response with exit code and signal
zero, empty stdout, and stderr `No child process (os error 10)`. The exact request
was a read-only supervisor PROBE. The original caller remained the cleanup
authority and later acknowledged the requested supervisor TERM. Existing
finalizer replay refusal correctly preserved its journal, but there was no CLI
route to continue a proven read-only history under a new operator source.

## Diagnosis

The native response passed through the raw observer and decoded receipt before
machine_control raised the generic `exact supervisor exec failed` ValueError.
The monitor correctly refuses malformed supervisor identities but could not
distinguish this captured native transport refusal. The owning replay fails with
that ValueError before the fix and yields a typed read-pending error afterward.
The actual saved request/response also reproduces this classification offline.
No cause for the native ECHILD response itself is inferred.

## Solution

Recognize only this exact response to the canonical bound PROBE command after
saving raw and decoded receipts. TERM and unrelated stderr remain hard failures.
Add explicit `--check --resume-journal` and `--resume-finalize --resume-journal`
commands. They retain the captured operator, source, epoch, native identity and
original journal, prove the previous finalizer process birth is dead, and verify
closed-world private journal contents contain only exact native GETs and PROBEs.
New operator bytes are bound separately. An exclusive successor journal prevents
repeating a partially executed continuation. Any cleanup/effect history refuses
this route. Existing supervisor TERM and canonical cleanup ownership are retained.

Focused controls cover the exact ECHILD envelope, read-only history, foreign
requests, journal mutation, process birth, and resumed cancellation through owned
cleanup and caller retirement. The actual run70 continuation subsequently
completed with finalizer `1fc5b729ced76dda398f997650b8ba5d08eb522b`:
the canonical terminal records controller release, cleanup exit zero and the
unchanged original workload epoch. The original read failure remains in its
retained journal; the failed benchmark was not regraded.

## Human feedback

Every fix must persist through the CLI. Preserve old receipts and original clocks;
never clear an unknown intent or replay a supervisor signal or cleanup operation.

## Reusable lesson

Distinguish a proven read-only transport refusal from malformed identity evidence, and resume only a source-bound history that contains no effects.
