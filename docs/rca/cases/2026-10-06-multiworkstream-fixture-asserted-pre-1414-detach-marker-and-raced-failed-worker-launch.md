---
id: 2026-10-06-multiworkstream-fixture-asserted-pre-1414-detach-marker-and-raced-failed-worker-launch
date: 2026-10-06
title: Multi-workstream fixture kept pre-change detach and worker-launch assumptions
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: fake flyctl machine clone dropped --override-cmd, so worker staging never reached launch
symptoms:
  - "FAIL: detached wait fleet left a consumed status rendezvous"
  - "FAIL: a fleet must fail when an autoscaled worker clone cannot launch"
  - waiting for native inert clone command
  - task finished before future worker demand was needed: 0/1 queue-ready
tags:
  - cloudbench
  - fixture
  - autoscaler
  - detached-monitoring
sources:
  - PR #1416
  - commit ab3f9edd7 (PR #1414)
  - commit a849df3f1 (PR #1410)
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

The `/deploy` Step 4cb Linux gate failed twice in the same suite after merging
current `main`. Scenario 2-wait reported a leftover `detached-*.status` file even
though its own fleet cleaned every resource. Scenario 2d's fleet exited 0, so the
mandatory failed-launch regression reported that the fleet did not fail.

## Diagnosis

Scenario 2-wait searched the whole runs root for any `detached-*.status`. Since
#1414 every detached launch writes an exact controller exit marker. Only `--wait`
consumes and deletes it, so the earlier 2-detach marker correctly survives as the
operator's terminal status. The glob observed that sibling file.

Scenario 2d's retained fixture shows the stage log ending at `waiting for native
inert clone command`, a `not-launched.json` cleanup receipt and the
forgiven-demand warning. #1410 made staging wait for the native row to show
`init.cmd == ["sleep", "infinity"]` from `clone --override-cmd`. The fake clone
ignored that flag, so `clone_cmd_inert` stayed 0 and every attempt was consumed
before launch. Holding the fake task longer only produced seven replacement
clones, each discarded before launch. The fake task can also finish before the
first launch command even when the gate passes; the never-ready sibling already
holds its task at that boundary, but 2d had no such hold. Forgiving unmet demand
after task completion is the intended #1410 contract, not a product defect:
that commit flipped `worker_capacity_loop_test.py` to require release and
deleted the final below-desired rejection. Scenarios 2e and 2f still asserted
the deleted rejection; with the clone repaired, 2e reached launch and passed
with the forgiven warning, while 2f failed closed with a different message.
Scenario 2j passed only vacuously: its "below desired" negative grep could no
longer match any controller output.

## Solution

The fake clone records `--override-cmd` as `init.cmd`, and fake `machine update
--command` replaces it, matching Fly. 2d asserts every worker clone carried the
inert override. The fake launch handler records an injected rejection, and the
existing 30-second launch handshake holds 2d's task until it occurs. After an
attempted launch, missing guest evidence quarantines ownership and the fleet
fails closed. 2e now requires zero queue-ready capacity, no queue join and a
captured terminal receipt for every launched unready worker before release. 2f
requires its blocked allocation to prevent terminal autoscaler completion.
2j requires a quiescent captured terminal receipt for every launched worker
retired after child completion. 2-detach asserts that its exact marker records exit 0; 2-wait asserts that its
own distinct marker was consumed. No product code or production timing changed,
so there is no 10k-agent runtime effect. The inert predicate's positive and
negative cases stay in `cloudbench_dependency_sync_test.py`.

## Human feedback

None recorded.

## Reusable lesson

When a controller starts gating on a native provider field, make the fake
provider persist the flag that sets it, and assert exact per-run artifacts.

## Readiness output binding after main integration

The normal Linux suite on `71241f2ef38162553df25d81d2e56c848e265aab`
passed its first 11 scenarios, then failed scenario 2e after 360.549 seconds.
The new capture assertion searched for
`*/autoscaler-worker-never-ready-<boundary>`, although both readiness boundaries
launch the unchanged task name `autoscaler-worker-never-ready`. Only the
controller log name has the boundary suffix. The failure occurred at the
output-directory cardinality assertion before any worker receipt was read.
This was a fixture binding error; it does not establish a runtime capture loss.

Changing the glob alone would leave a second error: the successful first
boundary's run directory remains when the second boundary starts. The fixture
now records the existing matching relative output paths before each launch and
requires exactly one new path afterward. It uses neither modification times nor
a task rename. Every existing launch, queue-readiness, captured worker identity,
quiescence, child-reaping, stream-closure, and provider-cleanup assertion remains.

Executing the actual extracted Python blocks reproduced both original selector
failures and passed the corrected selectors in 0.0082 seconds. The controls also
prove that an invalid older receipt is ignored, while zero or two new output
paths still fail. The complete normal Linux gate then passed all 32 scenarios
in 1002.687 seconds on `ba8bebe78bb7c7b83251937da26e2a73e247b0e8`, including
both readiness boundaries with every captured-worker assertion unchanged.
Its exact container was verified absent, and all 232 captured execution inputs
also match `9efb3dfa64ac71403e31d65612d21bdd74752f05`; the intervening packaging
changes do not alter those inputs. Its 2,147 exported regular files have mode
`0600`, and exported directories have mode `0700`. The terminal proof is retained
privately under
`.context/deploy-runs/20261006-024302-65153/main-integration-native32-readiness-binding-final/`.
The original failed run is
preserved privately under
`.context/deploy-runs/20261006-024302-65153/main-integration-native32-final/`.
Its exact native container was verified absent and all 232 captured source hashes
still matched the executed checkout. Cleanup did not retain the readiness output
directories, so their receipt contents were not independently reread afterward.
