---
id: 2026-10-06-failed-cohort-repeated-infra-canary
date: 2026-10-06
title: Failed strict campaign repeated its infrastructure canary after releasing the shared lock
surface: infra
component: cloudbench-infra-canary-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: failed canary released the transaction lock without publishing its failure to waiting controllers in the same cohort
symptoms:
  - one canary failed before fifty cached copies could allocate
  - campaign cohort was aborted while forty nine controllers remained in preflight
  - another waiting controller automatically allocated a second canary
tags:
  - cloudbench
  - strict-barrier
  - preflight
  - transaction-lock
  - failure-fanout
sources:
  - commit 02ca135bef520ba07bbd7c8612bbc880570cb7de
  - benchmark run campaign-20261006-091747-24225
  - fleet run 20261006-091850-42119
  - fleet run 20261006-093143-11800
repro: agents/benchmarks/cloudbench_campaign_barrier_test.py::test_campaign_start_barrier_failed_infra_canary_runs_once_per_cohort_and_next_cohort_can_retry
status: open
---

## Problem

A fresh-context agent ran the documented CLI with fifty unchanged cached copies,
concurrency fifty, one strict startup cohort and the temporary execution budget.
The original task-free infrastructure canary failed during Prisma bootstrap.
No outer benchmark allocated or executed, and the cohort never released.

The canary transaction helper returned failure and released its lock. A waiting
controller then acquired that lock, saw no success stamp and launched another
two-Machine canary. This was an automatic retry by the normal runner. The
campaign parent had already aborted the cohort, but controllers in preflight
did not observe the rendezvous abort marker until they reached the later gate.

Exact-parent cancellation stopped the rejected attempt. The original campaign
ended with one failed and forty nine cancelled controllers after 1,057.919
seconds. All fifty canonical API records became failed and nonlive. Four exact
Machines were absent, their volumes were terminal and unattached, all fifty-two
owner claims retired, and all recorded descendants and observers were absent.
The rejected attempt receives zero acceptance credit.

## Diagnosis

Boundary: failed canary → shared lock release without cohort failure receipt →
waiting controller sees missing success stamp → redundant canary allocation.
The Prisma error is a separate upstream defect; it does not justify repeating
the same infrastructure probe for every member of an already failed cohort.

Archive searches used `infra canary preflight failed repeated transaction lock
campaign aborted` and the observed one-owner/forty-nine-waiter behavior. Related
cases cover inherited script ownership, premature strict-cohort release,
duplicated inventory publishers and unnecessary snapshot restores. Runtime
ownership and the second printed nested handle establish this counterexample.

## Solution

The existing helper publishes a failure receipt in the owning cohort directory
before releasing the transaction lock. Waiting helpers observe that receipt and
the existing campaign abort marker while acquiring the lock. A new campaign or
cohort has its own directory and can retry normally. Standalone stamp/lock
behavior remains unchanged. The polling interval adds no new timeout or short
signal escalation.

Independent review found a caller bypass: the fleet shell returned immediately
on a fresh global success stamp, before consulting the helper. Campaign callers
now delegate that stamp check to the helper too; standalone callers retain the
fast path. A success in another cohort cannot override this cohort's failure.

The unchanged permanent owner fails on all three new functional cases against
the original source. A fixed helper with the original caller independently
reproduces the caller bypass. The final seven-case owner passes unchanged, and
the existing flag, owner, proxy and inherited-lock-descriptor controls pass.
The normal compact deploy selector discovers all three new cases. No task,
model, prompt, evaluator, dependency, harness execution budget or result is
changed. Actual final-source fleet validation remains pending.

At 10,000 runs, a failed cohort performs one failed infrastructure probe instead
of repeating it for waiting members. This is a bounded failure-path claim, not
a projected successful-fleet speed percentage. Private source-bound receipts
are under `.context/fresh-volume-provisioning-20261006/canary-failure-fanout/`;
raw runtime evidence remains private.

## Human feedback

The user requested deeply parallel repairs, compact regressions in deployment,
fresh-context CLI validation and no wasted retries or unnecessary resets.

## Reusable lesson

Publish a cohort failure before releasing its shared prerequisite lock, and
check that failure on every cached and uncached caller path.
