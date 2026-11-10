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

The reviewed slice/deadline fix is integrated at 93d2fbc224ff8b78e5b78ad0ad0eccd3ccd2d34c.
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

## November 3 typed control-plane recurrence

Request f118e520352e45e88e3017c209776c62 on source
93d2fbc224ff8b78e5b78ad0ad0eccd3ccd2d34c retained turn
01a19ebb-e74b-7ba1-b1f6-c6c4c98b4911. One native wait exited 2 with
`ok: false`, `errorCode: delegated_thread_control_unavailable` and the literal
boolean `retryable: true`. The original request deadline had not elapsed.
The adapter's deliberate generic nonzero-exit refusal ended observation
UNVERIFIED while the original worker continued. The platform occurrence was
reported as event 90fa4d46a84d47d5be95d87abf45b4b1; its internal cause remains
unidentified. A later read of that same turn succeeded, and the original
controller worker completed all twelve suites with native exit 0. That native
result is audit evidence only: the lost outer observation is not backfilled
as PASS. Canonical observation-loss re-execution is still required.

The narrow transport repair retries only a parsed dictionary carrying all
three exact fields: `ok is False`, `retryable is True` and that error code.
It re-observes the saved turn at the existing poll cadence inside the original
deadline. It neither sends again nor retries the worker task. Malformed,
generic, permission and non-retryable errors still end UNVERIFIED immediately
with the cleanup owner. Repeated typed errors still expire at the original
deadline; cancellation is checked before each observation.

Two causal controls fail against unchanged 93d2; the patched Boxes cohort
passes 30/30, including exact same-turn/one-send assertions, refusal variants
and the persistent-error deadline control. Independent review found no
blocker. Patch SHA256 is
79939dab581fd896491f7d41b1986cea08d79ab8a2e3224655e443e1fc7ada58.
The private before/after proof is retained under
/var/tmp/pr1662-retryable-wait-93 and the original outer receipt under
.context/deploy-pipeline-successor/attempts/9/focused/cloudbench-controller.
The transport repair remains awaiting terminal-boundary source integration
and a fresh qualified outer execution; no provider or benchmark assertion,
timeout, concurrency or task command changes.


## November3 accepted-send observation recurrence

Source c492 requestff9d2c470d054772aa917ea34fdd0002 reached the remote
worker, but its first20-second send slice expired before the acknowledgment
was observed. The adapter retained an UNVERIFIED receipt with null turn and
message identities. Same-key durable recovery identified the accepted turn;
the original worker completed normally with a same-turn full platform result
and clean native audit. No second task was sent and the original outcome was
not changed into PASS.

The transport now adopts the persisted token after that initial slice expires,
inside the same original deadline and cancellation. Native nested read-host
identity is accepted only with the bound thread, and conflicting claims fail
closed. A SHA-bound native send receipt may resolve null identities for
cleanup reconciliation only; all known original owner fields remain exact,
the original owner stays immutable and resolved identity is recorded separately.
The actual canonical reconciliation accepted the terminal audit and preserved
the original adapter/coordinator bytes; legitimate execution recovery remains
required. Integrated controls passed35 Boxes and77 Cycle tests once.
Reviewed combined patch SHA256:
6785313de8e2b5c30d2181c08af7fdde9e18e0486425dab6e5185a96e3a863e9.
