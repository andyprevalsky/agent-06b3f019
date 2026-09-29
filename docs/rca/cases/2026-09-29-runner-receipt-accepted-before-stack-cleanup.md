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
After that invalid confirmation was preserved separately, the next exact
recovery exposed a second gap: the guest state was `exited`, with no driver
descendants, but its services manifest still said `failed`. The quiescence
helper correctly rejected this as not durably stopped, while the fleet refused
to enter its existing exact Machine-stop/provider-cleanup fallback.
After exact Machine stop and provider cleanup succeeded, recovery still tried
to recapture sealed runtime evidence from that stopped guest before clearing
the independent guest-cleanup latch. This prevented the failed-run forensic
archive from being built, even though the original volume and exact cleanup
receipts remained available. The interrupted driver's original state was
`exited`, its PID file was absent, and its services manifest was `failed`;
the older archive verifier only accepted the pre-interrupt `running` state.
No task prompt, evaluator, scoring rule, or execution timeout was changed.

## Diagnosis

The observed path was benchmark-root interrupt cleanup → guest stack cleanup
failure → no guest acknowledgement → recovery. The first incorrect promotion
was in `cloudbench_recover_guest_cleanup_receipts`: the `clean` runner-receipt
branch called `recover-runner-receipt` and published the whole-guest confirmation
without checking `/shutdown-health`. An already persisted runner-only recovery
receipt took the same shortcut. A separate collector loop treated HTTP 409 as
transient until its deadline and did not inspect the terminal shutdown state.
The recovery fallback accepted `active` and `exited-no-run`, but excluded a
validated `exited` driver whose stack cleanup failed. That excluded precisely
the guest for which an exact Machine stop is needed before provider release.
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
already terminal guest failure. The added
`test_unquiesced_guest_seals_sessions_then_stops_exact_machine_before_cleanup[exited-with-failed-stack-cleanup]`
failed before the second fix with `exact guest quiescence rejected: guest
services are not durably stopped`; the identical test passes afterward and
asserts Machine stop precedes provider cleanup.

## Solution

`run-bench-fleet` now requires authenticated `/shutdown-health` HTTP 204 before
a clean runner receipt can confirm whole-guest shutdown. If that proof is
absent, it preserves any earlier runner receipt separately and proceeds through
the existing exact guest/process/provider recovery. The runtime-evidence
collector probes the same authenticated shutdown endpoint after HTTP 409 and
fails immediately on its terminal HTTP 500; ordinary delayed sealing retains
its existing bounded wait. A validated unquiesced `exited` driver now joins
the existing exact Machine-stop/provider-cleanup fallback. Blackbox tests
cover failed, healthy, and previously persisted runner receipts, terminal
collector failure, and stop-before-provider-cleanup ordering. Exact guest
cleanup now releases only its own latch before attempting runtime recapture;
the runtime-evidence latch and pool claims remain retained until the original
bytes are archived and verified. The zero-credit interrupted archive accepts
an absent original driver PID only with original `exited` state, `failed`
services, and exact stopped-Machine/provider receipts. Its recovery path also
stops the other acknowledged pool Machines before the native archive verifier
can release any claim. A live recovery and
ten consecutive complete slices are still required before this case can be
marked fixed.

The interrupted run's original archive passed exact-owner/native verification
with zero proof credit and returned all ten stopped pool claims. The planner's
boot held the synchronized slice barrier roughly eight minutes longer than
its peers while its shared CPU showed sustained pressure. It now receives the
existing 8GB/shared-CPU-4x primary shape for real execution, reusing a 20GB
pool volume through the already verified dynamic resize path. The next slice
showed the planner ready alongside peers, but `image-handling` then held nine
ready stacks at the barrier with its worker not listening and CPU pressure
reaching 84.59%. That attempt was canceled before task execution, with no
acceptance credit. `image-handling` now receives the same resource-only large
primary; its startup and cleanup still need live verification.

That cancellation also exposed a terminal collector wait: a guest can
acknowledge clean shutdown before any benchmark run record exists. The runtime
endpoint correctly returns 409 forever in that state, while authenticated
`/shutdown-health` returns 204. Both normal and recovery collectors now fail
closed immediately on that combination, leaving the runtime-evidence latch
for zero-credit forensic capture instead of waiting 600 seconds per guest.

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
