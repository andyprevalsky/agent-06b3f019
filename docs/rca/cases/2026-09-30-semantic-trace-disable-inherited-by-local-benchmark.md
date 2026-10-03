---
id: 2026-09-30-semantic-trace-disable-inherited-by-local-benchmark
date: 2026-09-30
title: Local benchmark inherited a semantic stack's disabled trace capture
surface: harness
component: local-benchmark-admission
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The private smoke launcher inherited TRACE_ARCHIVE_ENABLED=0 before agents/benchmarks/local.py admitted benchmark allocation
symptoms:
  - "Cloud evidence finalization failed: owned cloud root final archive was not confirmed"
  - "manifest_ref=null fixture_ref=null artifact_count=0"
  - completed browser task becomes benchmark_status ERROR during final archive collection
tags:
  - trace-archive
  - local-benchmark
  - semantic-stack
  - environment-admission
  - predeploy-smoke
sources:
  - PR #1299
  - commit 05a722cc77a232b4699d92bc6542df7966ff5fd6
  - agent 65a0dd07-925f-4095-9981-d0519fcb3782
repro: agents/tests/blackbox/benchmark.blackbox.py
status: open
---

## Problem

The unchanged local predeploy smoke task `browser-biometrics-webdecoy` reached
COMPLETED with an initial passing evaluation, 24 vendor calls in its usage
record, and 273.8 seconds of execution. These usage counts are not acceptance
LIVE-query proof. The owning batch's final archive collection then received no
manifest reference and correctly changed the task to ERROR. The entire smoke
gate earns zero credit. Its launcher ultimately exited 143 after 474.725
seconds; queued tasks did not become completed benchmark outcomes.

The private launcher had copied a semantic latency stack's process environment,
including `TRACE_ARCHIVE_ENABLED=0`, into both smoke and payment configurations.
The retained smoke backend's native process environment independently confirmed
that override. Backend finalization reported a null manifest and zero artifacts
twice. The exact root's cleanup evidence recorded the missing-archive error;
provider cleanup did not establish missing durable trace capture as valid.
Original artifacts and diagnostic outputs remain private under `.context/`.

## Diagnosis

The critical path was launcher environment → local benchmark admission →
`scripts/run.sh --benchmark` environment → backend archiveEnabled → actual
finalizeAgent → strict owned-batch manifest assertion. `run.sh` defaults an
unset or empty archive flag to 1 but preserves an explicit 0. The backend
correctly treats 0 as disabled, so the archive writes return null. The strict
benchmark guard correctly refuses to count that task's final evidence.

Archive searches used `owned cloud root final archive was not confirmed` and
`local benchmark trace archive disabled finalization missing manifest`.
The read/writer storage mismatch case
`2026-07-04-shared-env-r2-archive-backend-diverged-from-test-local-read` is a
relative: it concerns storage-backend disagreement, not an intentionally
disabled writer. No exact earlier case owned this launcher boundary.

The causal reproduction ran the actual finalizer against this exact retained
root and its real isolated database, with a private local archive directory.
The same assertion required a nonempty manifest reference and an encrypted
manifest that decrypted to this root with finalized=true. With only the capture
flag changed, it failed at the null-reference assertion in 0.813 seconds
(exit 1, capture disabled), then passed in 0.941 seconds (exit 0, enabled).
The command used pinned Node 22.13.0 and the repository tsx CLI with
`.context/acceptance/smoke-archive-rca/finalizer-repro.private.mts`; the unchanged
script, configuration and receipts remain private. This postmortem snapshot
cannot reconstruct the original missing provider traces and grants zero
benchmark proof credit.

The deepest proven admission gap was that a local benchmark could allocate
services despite an explicitly disabled prerequisite for its durable evidence.
That same gap also admitted the sibling payment launcher. The backend's
deliberate archive-disable capability remains appropriate for semantic latency
stacks; removing it globally would change the wrong owning boundary.

## Solution

Correct the private smoke and payment launcher configurations to enable normal
benchmark capture. Add `validate_benchmark_archive_environment` in local.py,
called after selection and before single-world or cohort service allocation.
It rejects the backend's explicit false values with a clear configuration
error. It preserves default/enabled settings and never overrides an operator's
flag. Its whitespace normalization follows JavaScript String.trim, including
BOM and excluding Python-only control whitespace. Ordinary semantic stacks
do not invoke this benchmark admission path.

The permanent benchmark blackbox initially failed on the pre-fix launcher,
then passed unchanged. It asserts zero stack/cohort allocation for disabled
values and normal admission for unset, empty and enabled values. Independent
review found a BOM parser discrepancy; a permanent BOM counterexample failed
before the normalization repair and passed afterward, together with checks
that JavaScript-retained control characters are not removed. The test is
registered in run_all_tests, discovered by the benchmark domain, and executed
through the existing `/deploy` agents coverage lane. It adds about 0.05 seconds
in the focused run and retains the original 300-second domain budget.

Eight focused admission, payment-environment, cache-contract and fixture
regressions pass. Ruff lint and formatting pass. AST comparison proves that
formatting the two touched files leaves all previous behavior unchanged after
removing only the new guard, its call, the new test and its registration.
The admission check is constant work per launcher, with no network requests,
shared locks, agent scans or added model calls at 10,000 agents.

Independent review passed the final source and permanent regression, reproduced
the committed pre-guard admission failure using the unchanged final test, and
verified 161 actual Node trim/false-set cases. It confirmed that all existing
AST behavior is unchanged outside the intended additions.

The full agents coverage lane passed all 103 domains in 336.40 seconds with
80% total coverage; the benchmark domain took 268.67 seconds within its unchanged
300-second budget. Source hashes remained unchanged throughout verification.
The fresh canonical smoke run is exercising enabled capture. This case remains
OPEN until the unchanged task has a fully finalized outcome with complete durable
evidence and verified teardown. A genuine task FAILURE is acceptable; missing
evidence or failed cleanup is INFRA. A passing causal test alone does not close
the reported benchmark failure.

## Human feedback

The user requires complete durable evidence and forbids granting acceptance
credit for partial results or recovery receipts. Preserve normal 7,200-second
backstops and do not change tasks, prompts, models, evaluators or acceptance
requirements to manufacture a pass. Continue infrastructure repair without a
separate cybersecurity investigation.

## Reusable lesson

Validate mandatory capture settings before allocating benchmark resources, and keep semantic latency overrides out of durable benchmark launchers.
