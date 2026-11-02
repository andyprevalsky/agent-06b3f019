---
id: 2026-11-02-native-wait-slice-mistaken-for-request-deadline
date: 2026-11-02
title: A native wait slice timeout prematurely ended a live staged worker request
surface: harness
component: deploy-test-boxes
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: A 20-second native threads wait TimeoutExpired escaped to the whole-request timeout handler with 14374.262 seconds remaining
symptoms:
  - original deadline passed during native CLI call
  - native worker continued after the transport returned UNVERIFIED
  - SIG_IGN CLI exceeded an original 0.8-second deadline
tags:
  - deploy
  - worker-transport
  - deadlines
sources:
  - PR #1662
  - commit c13dc65fa03083ac6c4490f0c572ae21c439f8da
repro: scripts/tests/deploy-test-worker.test.py
status: open
---

## Problem

Occurrence 94e7e290fe814be6b3710ba01168e08f belongs to controller request
0675a5465b234c1884057e6fdc92de2c. The adapter ended its observation after a
19750ms native wait exceeded the 20-second CLI slice. Its saved absolute
14400-second request deadline still had 14374.262 seconds remaining. The
native worker turn 01a19e57-e7ec-7d60-94d0-b93da3089917 continued unchanged.
The original transport outcome remains UNVERIFIED with its cleanup owner;
no worker result is retrospectively credited to this lost observation.

## Diagnosis

Gate: INTRODUCED in the new staged transport. The bounded CLI helper raised
TimeoutExpired for one observation slice, but the adapter handled it as a
whole-request expiry. The exact c13 same-turn replay produced UNVERIFIED
instead of the expected PASS. A separate real SIG_IGN CLI control took
0.9733 seconds under an original 0.8-second deadline because termination and
reaping extended outside the advertised call budget. Nonzero wait failures
were also mislabeled as deadline exhaustion.

The author retained causal pre-image logs and exact private proof. Native
read-only threads wait with 1ms returned exit 0 and status timeout in 0.712s;
that status was already on the ordinary re-observation path. No provider
operation, duplicate worker send, benchmark retry or deadline reset was used.

## Solution

Reviewed candidate only, awaiting parent integration and full gate execution.
Catch TimeoutExpired only around threads wait. If the same original absolute
budget remains and cancellation is absent, re-observe the saved turn without
another send. Global expiry or cancellation retains cleanup_owner and remains
UNVERIFIED. Short non-wait timeouts report that the original deadline remains.
Keep execution, TERM grace, KILL and bounded reap inside both the per-call
20-second ceiling and the original deadline. Nonzero wait exit now deliberately
ends the attempt UNVERIFIED with its owner; a later adoption uses the saved turn.

Final patch SHA256:
77b028c283ac1e7d38eb93302516c60afcac1a78b392500a5bcfdd53ed87e618.
The full Boxes suite passed 27/27 in 23.813s and five causal controls passed
five consecutive repetitions. The real SIG_IGN control finished in 0.7223s
under 0.8s. Both deadline reason strings are asserted by native controls.
Independent review found no blocker and confirmed the final packet equals
the reviewed base plus its small exact-text pin delta. Only the transport and
its owning worker tests change; gate budgets, providers and worker commands
remain unchanged. Evidence is retained in /var/tmp/pr1662-boxes-wait-slice and
.context/preparation/c13-controller-native-terminal on the originating box.

The underlying worker later terminated normally with exit 1, quiescent true,
no remaining children and cleanup_complete true. It recorded eleven suite
PASS rows and a selected-pytest cleanup UNVERIFIED row after 518 pytest passes.
That independent fixture cleanup defect has its own RCA case. A new full
controller execution on the integrated source remains required.

## Human feedback

The user requires the finished deployment and complete validation. Observation
loss cannot be invented into a passed gate or justify a duplicate remote run.
Preserve the original turn, source, deadlines, native evidence and cleanup owner.

## Reusable lesson

Distinguish a bounded observation slice from the original task deadline and
include termination/reaping in the same advertised CLI budget.
