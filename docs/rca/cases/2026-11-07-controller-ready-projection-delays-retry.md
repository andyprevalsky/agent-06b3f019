---
id: 2026-11-07-controller-ready-projection-delays-retry
date: 2026-11-07
title: Controller active-retry failure remains open with a proven readiness publication defect
surface: harness
component: cloudbench-controller-readiness
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Original fake driver reports CHILDFAIL after replacement readiness; exact original cause remains unproven because task artifacts were cleaned
symptoms:
  - FAIL: readiness active-retry must preserve completed task and exact worker retirement
  - autoscaler-worker-never-ready REAL CHILDFAIL
  - worker joined queue after a replaceable readiness failure
tags:
  - cloudbench
  - readiness
  - controller
  - fixture
sources:
  - PR #1708
  - commit 60ca0ff528360e8e54198cec54c00a11fab4a50e
  - commit 0d3a03ae0da476027bfceaf35724c75744062119
  - commit b365bf8bd69346f872e5e2cb7218872155ca294d
  - fleet run 20261107-193128-3227026
repro: scripts/tests/cloudbench-worker-readiness-publication.test.py (private proposal only)
status: open
---

## Problem

Gate: UNKNOWN for the original controller failure. Do not promote the controlled
replay or passing readiness-only runs to original-gate verification.

The original native controller step ran `bash
scripts/tests/cloudbench-multi-workstream.test.sh` and exited 1 at
2026-11-07 19:32:50 UTC. Its receipt records 828.989 seconds, quiescent true,
orphaned_children false, no timeout and no cancellation. Eleven sibling steps
passed according to the supplied parent gate evidence; this child did not rerun
that full gate.

The first real assertion is `FAIL: readiness active-retry must preserve completed
task and exact worker retirement`. Other errors in that log belong to intentional
negative tests and do not establish the cause of this assertion.

The supplied original log SHA256 is
68f9130f0967b728cc4fa0ac12b375a555bd1920a47187a59f4ac7342d8281aa.
The copied receipt SHA256 is
7a399ede7ba3f1e1e745a44929fac1b80d8757bd9b27eb4135fade658e78f04c.

## Diagnosis

Critical path: fake driver keeps work active -> real controller provisions a
worker -> five-second queue-readiness failure -> real worker capture and exact
retirement -> replacement becomes queue-ready -> aggregate ready ledger ->
fake driver's real task result -> controller summary and shell assertion.

Original observations:

1. Primary 5235cc9dd03f44 reports REAL CHILDFAIL, 0/1 passed.
2. Worker 546a58aed0734d fails readiness within the existing 5s bound and is
   removed so capacity can be retried.
3. Replacement cf8960fe15214e joins its exact task queue.
4. The autoscaler has `autoscaler.completed-after-child`; the controller
   destroys the primary and replacement. This is distinct from a native orphan.
5. `/var/tmp/cloudbench-local-multi-workstream-l52oqbp0/tmp.Ooh33aVXDz` is absent.
   The parent confirmed ordinary test/supervisor cleanup removed it; it had not
   copied the primary run.json, bench.log or worker capture JSONs. Original
   per-event timing and the fake driver's exact fatal line cannot be recovered
   from the retained aggregate tail. Do not fabricate them.

The supported retained readiness-only run on frozen 60ca0ff passed. A second
reduction also passed with the readiness function and its original assertions
byte-identical. The reduction removed unrelated Python prerequisite suites and
the recursive cleanup self-test, not task conditions. These green pre-fix runs
are an outcome-reproduction gap, not evidence that the original failure was
fixed.

The first retained run observed first-worker launch at 19:39:42.385 UTC, its
terminal capture at 19:39:48.879, replacement launch at 19:39:56.138, and aggregate
ready publication at 19:40:04.365. The active handshake used approximately 22 of
its original 30 seconds. Its raw timeline and JSON copies are in
`before-observer/`; this is a new observation, not recovered original evidence.

An independent deterministic control proves a narrower defect. It executes the
unchanged `run_fake_driver` function and actual `publish_worker_ready`, ledger
locks and reconciler. Only the fake driver's time source and provider state are
controlled. No task success value is supplied: the original driver produces and
stamps the task result. The original five-second stage text, 30-second consumer
deadline, identity checks and rejection checks remain unchanged.

With capture/retirement at simulated second 22, replacement queue readiness at
27, and the next normal ten-second aggregate poll at 32, the original driver
produces passed=false at its unchanged deadline. The exact original assertion
fails. Calling the existing locked readiness reconciler when the producer
publishes readiness makes that same consumer and assertion pass at second 27.
Foreign terminal identity and cancelled-worker controls remain rejected.
This controlled schedule is NOT a captured original timeline.

Exact repeatable command, from /home/boxes/rose:

    python3 -B .context/rca-browser-4f77/controller-retry-rca-1934/child/candidate/scripts/tests/cloudbench-worker-readiness-publication.test.py

It exited 1 before the private fix, then 0 after it. Five subsequent unchanged
runs exited 0 in 0.576-0.628 seconds each. The same control exited 1 on extracted
sources from original 0d3a03ae, pinned main b365bf8b and frozen 60ca0ff, each at the
same task assertion. `deterministic-runs.json` contains exact commands, times,
exits and the unchanged test hash. Core boundary hashes also match across those
revisions. This establishes that the controlled publication defect predates the
repair. It does not establish attribution for the unreproduced original failure.

Archive searches (both recorded before proposing a fix):

    python3 scripts/rca_archive.py search 'readiness active-retry must preserve completed task and exact worker retirement'
    python3 scripts/rca_archive.py search 'worker queue readiness retry completed task runtime evidence retirement'

The literal rg search found no exact archived assertion. The related case is
2026-10-05-controller-fixture-assumed-obsolete-terminal-capacity. Its Solution
and Human feedback were read. It requires real completed task success, active
work through captured retirement, and distinct unused-capacity handling. The
new proposal preserves those requirements. Recurrence of the original incident
is unproven; append to that old case only if original causality is later bound.

## Solution

Private proposal only, never applied to the canonical checkout:

- Publish the aggregate ready ledger through the existing lock-protected
  reconciler immediately after publishing a worker's readiness marker.
- Keep its existing exact tracked-worker and cancellation checks. Keep the
  autoscaler's normal reconciler as recovery/idempotent maintenance.
- Add the unchanged-consumer deterministic regression to the existing
  multi-workstream prerequisite list.
- Update the existing qualification producer test to load that real dependency
  and assert that both its qualification receipt and aggregate ledger publish.

This unifies the event and projection write path without adding a polling loop,
new timeout, provider request, fallback or task-result override. Runtime state
and retirement checks are unchanged. At 10k agents the added work is one bounded
per-fleet ledger reconciliation on a worker readiness transition, using the
existing per-fleet lock; it adds no global fan-in or recurring poll.

Five existing targeted tests passed: serialized cleanup/cancellation, concurrent
cleanup of different workers, dead-owner lock recovery/foreign release refusal,
reconciler failure reporting, and clean child-completion handling. The updated
qualification producer check passed five consecutive times. Six additional
existing provisioner/cleanup cases passed, including the original stage/readiness
failure handling and all parameterized primary-clone restore modes. Their shared
fixture bundle now loads the real reconciler rather than leaving its dependency
undefined.

The unchanged native readiness-only entrypoint also passed after the proposal:
`python3 -B .context/rca-browser-4f77/controller-retry-rca-1934/child/run_owning.py
owning-after` executed `bash scripts/tests/cloudbench-multi-workstream.test.sh`
with the existing readiness-only and retention flags, exiting 0 in 207.240s.
It exercised both active retry and finished-unused capacity, the original task
PASS assertion, worker terminal captures and exact disposable retirement. This
is a subset pass, not a full native gate pass, and its pre-fix subset also passed.

The observer saw the pre-fix per-worker ready marker at 19:39:56.363 and aggregate
ledger at 19:40:04.365, an approximately eight-second publication lag. After the
proposal it saw those boundaries at 19:44:53.302 and 19:44:53.408. These are two
separate runs with 0.1s observation granularity, not a statistical speed result
or the original incident's missing timeline. All timings and file hashes remain
in the private receipts and observer JSONL files.

Golden reference: not applicable to this private ordinary-code/fixture proposal;
no prompt, schema or agent trajectory is changed. No review, deploy or full native
controller gate was run. The parent owns integration after healthy writers
retire, full original-gate reruns and any required review. This RCA remains open
until the original cause and unchanged original outcome are proved.

## Human feedback

The user directed the existing deploy to continue relentlessly and required the original clock, failures, selected tests and capacity limits to remain intact. The parent required private proposals while the original healthy workers ran; that coordination constraint was not a new human approval request. Assertions and budgets must not be weakened. Freedom and its protected instructions remain untouched.

## Reusable lesson

Publish an accepted readiness event and its authoritative projection through one
locked path, and preserve the original failing task artifacts before treating a
related controlled replay as an incident diagnosis.
