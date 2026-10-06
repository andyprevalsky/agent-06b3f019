---
id: 2026-10-06-controller-cancellation-readiness-window-expired-during-startup
date: 2026-10-06
title: Controller cancellation fixture expired while startup published readiness
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: timeout-too-aggressive
first_bad_boundary: the cancellation fixture exhausted its 400 polling iterations as configuration readiness was being published before status proxy attachment
symptoms:
  - detached cancellation fixture never published its exact recoverable guest identity
  - boot ready and autoscaler identity publication coincided with fixture retirement
tags:
  - cloudbench
  - readiness
  - controller-fixture
sources:
  - commit 60137694b6c6186bf6cdd43ab8c2f54b7d8fc5ec
  - PR #1424 deploy
  - agent /root/fresh_basic_claude_final50_cli
  - plan:.context/fresh-basic-claude-final50-20261006/deploy/controller-readiness-followup.private/green-terminal.safe.json
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: open
---

## Problem

The mandatory native Linux multi-workstream control failed its detached
cancellation readiness condition on the final source. The original full fixture
failed in 130.923 seconds; its partial export could not prove the child files
were absent. One unchanged focused replay reproduced the failure in 39.006
seconds and retained a complete export. Neither attempt qualified the gate.

## Diagnosis

Two archive searches used the exact failure and cancellation readiness terms.
The September 27 cleanup-reserve case has the same symptom but proved a blocked
zero-fill synchronization operation. That fix remains present and its owning
controls pass here. It is a relative, not an established recurrence.

In the complete focused capture the launcher timestamp was 22:11:33 UTC, the
conservative task-start marker and exact Machine identity were published at
22:11:56, and boot readiness plus the autoscaler native identity at 22:11:57.
Native terminal inspection and retirement began in that same one-second bucket.
The one selected Machine matched the ready marker. The release marker and
status proxy were absent in the complete capture. These producer timestamps
have one-second resolution; they support a readiness-window race and do not
prove an indefinitely stalled parent or a failed autoscaler birth write.

The original fixed polling count permits about twenty seconds of sleeps plus
registry scans for an entire real controller startup. That includes host-side
packaging, dependency checks, allocation/configuration and proxy attachment in
an otherwise offline fake-provider fixture. An optional metadata HTTP warning
is retained, but its duration and contribution to the delay are unproved; this
repair makes no underlying transport-cause claim.

## Solution

Bound this infrastructure readiness phase with a 120-second elapsed-shell-time
window while retaining the same polling cadence. The exact Machine/volume,
fresh owned audit, task identity and nonempty status-proxy predicates are
unchanged. Every subsequent cancellation escalation, neighbor preservation,
acknowledged recovery and durable missing-evidence assertion is unchanged.
Production sources, task/model/prompt/evaluator behavior, task execution limits,
and allocation-to-full-release deadlines are unchanged.

## Verification

The same focused selector passed in 35.357 seconds on the timer-only candidate,
with no added instrumentation or endpoint changes. Reaching the existing exact
cancellation assertion requires the accepted post-barrier guest start and its
status proxy; the subsequent recovery and evidence-retention assertions passed.
The normal exact stop, private copy and removal all returned zero, and the final
inspect positively reported the exact container absent. The existing private
observer recorded zero errors. Independent source review confirmed that
restoring only the comments/deadline/loop replacement yields byte-identical
baseline and that all ownership assertions remain unchanged.

The original failures remain preserved. This focused result is not a complete
multi-workstream gate pass, a cached fifty-copy execution, or task credit. The
full mandatory native fixture and remaining deploy gates are pending, so the
case remains open.

## Human feedback

The user authorized considerably liberal infrastructure readiness budgets and
safe overlap of independent deploy stages while preserving task budgets and
honest failures. Root required actual full-start and unchanged recovery evidence
before accepting this fixture-only repair; those focused assertions passed.

## Reusable lesson

Give an aggregate infrastructure startup condition a measured elapsed-time
budget while preserving the exact resource identity and later lifecycle checks.
