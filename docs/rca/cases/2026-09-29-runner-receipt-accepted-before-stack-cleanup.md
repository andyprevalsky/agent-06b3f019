---
id: 2026-09-29-runner-receipt-accepted-before-stack-cleanup
date: 2026-09-29
title: Recovery promoted a clean benchmark-root receipt into guest stack cleanup
surface: infra
component: cloudbench-fleet-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet cloudbench_recover_guest_cleanup_receipts accepted a clean runner receipt without a guest stack acknowledgement
symptoms:
  - "FATAL: could not publish guest cleanup acknowledgement"
  - "driver cleanup evidence interrupt_status=1 cleanup_ack=0"
  - "guest cleanup request failed (HTTP 500)"
  - "terminal runtime evidence deadline expired"
tags:
  - cloudbench
  - fleet
  - teardown
  - ownership
  - runtime-evidence
sources:
  - PR #1299
  - fleet run 20260929-161610-10375
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

The smoke-inclusive ten-benchmark slice on commit `f1c5d5f26` started all ten
stacks and nine tasks produced evaluated run records with 5–60 verified
successful LLM completions. The planner guest took roughly eight additional
minutes to become healthy. Its benchmark-root interrupt receipt was `clean`,
but `run.sh` published `state=failed` for stack cleanup; the worker supervisor
remained live, and the driver withheld the guest cleanup acknowledgement. The
guest reported HTTP 500 from `/shutdown-health`. The slice is an INFRA failure
and earns no acceptance credit.

The fleet's cancellation recovery treated the narrower benchmark-root receipt
as sufficient to publish `guest-shutdown.confirmed`. It then waited the full
600-second runtime-evidence deadline on HTTP 409 even though the same guest had
already reported the terminal HTTP 500. Recovery failed with ownership retained.
No task prompt, evaluator, scoring rule, or execution timeout was changed.

## Diagnosis

The observed path was benchmark-root interrupt cleanup → guest stack cleanup
failure → no guest acknowledgement → recovery. The first incorrect promotion
was in `cloudbench_recover_guest_cleanup_receipts`: the `clean` runner-receipt
branch called `recover-runner-receipt` and published the whole-guest confirmation
without checking `/shutdown-health`. An already persisted runner-only recovery
receipt took the same shortcut. A separate collector loop treated HTTP 409 as
transient until its deadline and did not inspect the terminal shutdown state.
The deeper general class is using a receipt from one ownership scope to attest
to a larger scope. The original stack-cleanup failure remains under investigation;
these two recovery bugs are independently reproduced and repaired.

Two RCA archive searches were run: `could not publish guest cleanup
acknowledgement stack worker cleanup failed` and `worker supervisor did not
finish graceful cleanup process birth identity`. The September 11 cloud archive
case is related, but its primary stack guardrail worked here: it refused the
ACK. This case records the distinct recovery boundary that subsequently
upgraded the runner receipt.

The unchanged local repro command
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_clean_runner_receipt_cannot_ack_failed_guest_stack`
failed before the fix with `positive runner cleanup receipt is invalid`; the
fixture asserted that full exact provider cleanup must run instead. The
terminal-collector repro in
`scripts/tests/cloudbench-runtime-evidence-collector.test.py` failed before the
fix because it reached its three-second deadline rather than reporting the
already terminal guest failure. Both same tests pass after the fix.

## Solution

`run-bench-fleet` now requires authenticated `/shutdown-health` HTTP 204 before
a clean runner receipt can confirm whole-guest shutdown. If that proof is
absent, it preserves any earlier runner receipt separately and proceeds through
the existing exact guest/process/provider recovery. The runtime-evidence
collector probes the same authenticated shutdown endpoint after HTTP 409 and
fails immediately on its terminal HTTP 500; ordinary delayed sealing retains
its existing bounded wait. Blackbox tests cover failed, healthy, and previously
persisted runner receipts plus terminal collector failure. A live recovery and
ten consecutive complete slices are still required before this case can be
marked fixed.

At 10,000 agents, this adds one bounded status request only for a guest missing
its normal shutdown confirmation. It does not inventory other agents or
providers. In the observed terminal state, the collector's futile wait falls
from 600 seconds to under one second in the local boundary repro.

## Human feedback

The user requires infra-only changes, ten consecutive sequential cloud slices
of ten real tasks with zero INFRA, at least three successful LLM completions per
bench, smoke benches, exact evaluation and teardown, a temporary five-minute
benchmark backstop, and a 30-minute full E2E kill cutoff. After each valid
slice, report the slice and individual E2E times and repair safe infrastructure
changes saving more than five percent of wall clock. Do not change the harness
to make benchmark outcomes pass.

## Reusable lesson

Never promote a clean receipt for one lifecycle owner into proof that a larger
owner has shut down; query the larger owner's terminal state before acknowledging it.
