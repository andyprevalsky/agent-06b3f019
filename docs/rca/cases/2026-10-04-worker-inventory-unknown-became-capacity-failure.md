---
id: 2026-10-04-worker-inventory-unknown-became-capacity-failure
date: 2026-10-04
title: An unknown worker inventory observation became a terminal capacity failure
surface: infra
component: fleet-worker-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet reserve_worker_machine_slot and provision_worker
symptoms:
  - Machine-count capacity unavailable for worker clone
  - worker capacity inventory unavailable; admission pending
tags:
  - autoscaler
  - inventory
  - admission
  - observation
sources:
  - PR #1299
  - fleet run 20261004-181653-20858
repro: scripts/tests/benchmark-live-results.test.py
status: mitigated
---

## Problem

All fifty primary benchmarks executed and reached evaluated outcomes, and all
fifty Machines stopped. One task requested an extra worker and recorded a
generic capacity-unavailable failure without allocating one. Native inventory
showed eighty-seven app Machines against the configured ceiling of eighty-eight;
no numeric capacity-denial notice or retained startup reservation was found.
This does not prove quota exhaustion. The exact failed inventory response was
discarded, so its transport/parse/guard trigger remains an open observability gap.

## Diagnosis

An empty or malformed native inventory returned the same failure as a genuine
serialized capacity denial. `provision_worker` relabeled it as terminal capacity
failure. The old pipeline could also accept valid stdout from an unsuccessful
provider command. The loop did not explicitly distinguish pending observation
from failed provision, allowing another attempt in the same scale-up pass.

Two archive searches found the August 3 post-child worker-ledger contention case
as the closest relative: an observation/admission distinction was similarly lost.
Independent real-function controls, with the actual locked capacity transaction,
failed 2/7 and passed 7/7 with the same driver. A full real autoscaler-loop and
child-supervisor control failed 0/3 and passed 3/3 after the fix. It covered
next-poll recovery, persistent unknown through child termination, and a genuine
provision failure. All recorded fixture processes retired. Private traces and
receipts are retained outside git; no model or provider calls were added.

## Solution

Require successful native observation before reservation. Unknown observation
returns pending status 75, allocates nothing and writes no terminal failure.
The autoscaler ends that scale-up pass and re-observes on its existing poll,
checking child and owner lifecycle first. Genuine capacity denial and provision
failure remain hard failures. Persistent unknown cannot claim fulfilled worker
demand after the task terminates. The five existing capacity transaction helpers,
provider ceilings and task/E2E deadlines remain unchanged.

The compact automatic deploy gate exercises real admission and the full loop;
the owning benchmark blackbox registration also invokes it. Independent review
verified unchanged serialized admission and no new timeout or quota bypass.
The original failed native response remains unknown; a fresh live fifty-wide
outcome proof is pending at this archive revision.

## Human feedback

The user requested breathing room around infrastructure observations, emphasized
that genuine benchmark failures are acceptable, and rejected optional diagnostic
timeouts as automatic rejection signals. They kept real execution, terminal
results and exact resource release as the mandatory end goal.

## Reusable lesson

An unreadable capacity observation admits nothing and remains pending; only
authoritative capacity denial or failed provision proves an admission failure.
