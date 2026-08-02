---
id: 2026-07-13-one-bench-producing-no-run-json-aborts-whole-fleet-batch
date: 2026-07-13
title: A broken warm image made one bench produce no `runs/*.json`, so it never signaled barrier-ready and the controller aborted all 7 benches
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: fleet synchronized-start barrier — barrier-ready is signaled only after an on-box run saves runs/*.json, so one bad box aborts the batch
symptoms:
  - "all 7 clones fail identically at the synchronized-start barrier: 0/7 ready"
  - 'on-box run_benchmark.py --ci exits 1 with finished=1, timed_out=0 and "no runs/*.json produced"'
  - six of seven bench outputs are empty with no error of their own
tags:
  - cloudbench-fleet
  - warm-image
  - barrier
  - run-record
  - fail-fast
sources:
  - memory:project_cloud_smoke_infra_blockers_jul2026
repro: none-recorded
status: open
---

## Problem

Fleet attempt 5 finally cleared the volume-snapshot gate and forked all 7 clones,
then **all 7 failed identically** at the synchronized-start barrier with
`0/7 ready`. Only the chat-mode bench produced any output at all: its on-box
`run_benchmark.py --ci` exited 1 reporting `finished=1, timed_out=0` and
"no runs/*.json produced". The other six produced nothing.

## Diagnosis

Two layers.

The trigger was the warm image `cloudbench-warm-20260713-101303`, rebuilt
externally, which carried a run-record-save regression: the on-box run completed
(`finished=1`, not a timeout) but never wrote its `runs/*.json`. This was
established as _not_ branch code — chat-mode passes locally on the exact ref
`bdb07f9b3` (run→save→PASS path healthy), the branch diff does not touch agent
runtime, and the local `run-bench-fleet` diff only touches pool/clone-ownership
allocation, not the barrier or the on-box run/save path.

The amplifier is the owned harness defect: **barrier-ready is signaled only after
an on-box run successfully saves a run record.** So a single box that cannot save
withholds its signal, the barrier never reaches N/N, and the controller aborts the
entire batch — six healthy benches were destroyed by one broken one and reported
no error of their own, which is exactly what made the diagnosis expensive.

## Solution

Immediate: rebuild the warm image from current code via
`run-bench-cloud --setup` (a heavy shared-infra mutation — get approval before
running it).

The barrier's all-or-nothing coupling remains the standing weakness: as long as
one non-signaling box aborts the batch, an unrelated per-box fault presents as a
whole-fleet failure with no attributable cause.

## Human feedback

Rebuilding the warm image was explicitly gated on approval as a heavy shared-infra
mutation rather than performed unilaterally to unblock the run.

## Reusable lesson

When every bench in a fleet fails identically at the barrier and only one produced
any output, read that one's output — the batch abort is a consequence, and suspect
the shared warm image before the branch diff.
