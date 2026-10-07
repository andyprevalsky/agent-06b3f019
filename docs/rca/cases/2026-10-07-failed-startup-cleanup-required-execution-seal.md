---
id: 2026-10-07-failed-startup-cleanup-required-execution-seal
date: 2026-10-07
title: Exact failed-startup cleanup required a complete task execution seal
surface: harness
component: cloudbench-exact-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: exact-owner recovery recaptured only complete task evidence after real startup-failure cleanup and later selected reconnect only from accepted-start markers
symptoms:
  - guest shutdown without sealed runtime evidence
  - real shutdown acknowledgement clears guest cleanup while runtime ownership remains
  - one started but locally unaccepted startup remains after forty-nine primary retirements
tags:
  - cloudbench
  - startup
  - exact-owner-recovery
  - evidence-retention
sources:
  - fleet run 20261007-020659-75781
  - commit 681481df0425caf0a8d2157b872027b11a8ef8f9 (original guest source)
  - commit 2a252b3852a9e308a051794e4f0226ced5458a36 (recovery caller)
repro: test_exact_recovery_consumes_runtime_receipt_failed_startup_archive
status: open
---

## Problem

The original ordinary DAILY50 controller failed after forty-nine task results
and one startup rejection. Its Gmail primary actually started with the exact
original native config, despite the local post-config start request being
rejected during migration. Missing local acceptance is not native absence.
The original run permanently earns zero full-width acceptance credit.

Reviewed exact-owner recovery subsequently acknowledged this guest's actual
cleanup and cleared only the guest-cleanup latch. Complete task recapture then
received HTTP 409 after shutdown-health 204. The collector correctly raised
`guest shutdown without sealed runtime evidence`; neither a task result nor a
sealed runtime bundle was fabricated. One original primary, its volume and the
runtime evidence latch remained owned. Forty-nine primaries and two workers had
already reached their independent native terminal scopes.

## Diagnosis

The normal status producer requires exited cleanup, stopped services, run.json,
the complete backend/worker inventory and stack cleanup for a task evidence
seal. A truthful cleanup acknowledgement does not prove a task run exists.
The completed-execution collector's post-ACK 409 refusal is correct: the existing
registered terminal-failures control passes unchanged for both collectors and
the missing-cleanup inverse.

Recovery only consumed a pre-existing whole-run forensic archive. Its generic
verifier expected every task allocation still active, while this original owner
had one active allocation and forty-nine positively retired histories. After
the guest latch cleared, reconnect selection additionally required an accepted
start marker, excluding the original pending runtime owner. This is an owning
cleanup producer/routing gap, rather than an execution-acceptance exception.

Archive searches were `guest shutdown without sealed runtime evidence` and
`shutdown runtime evidence startup rejection forensic`. The September 27 runtime
retention case establishes the unchanged complete-task seal and separate cleanup
latch. The October 6 mixed-phase forensic case supplies the existing pre-service
and stopped-provider contracts. The October 7 retired-output planner case binds
the one active allocation to its positively retired histories. These are related
contracts; none supplied this per-active-output rejection-only capture route.

## Solution

The documented exact-owner CLI now reconnects an exact pending runtime owner
without requiring local start acceptance. For the original terminal startup
exit 125, it can preserve a distinct zero-credit archive after authenticated
cleanup. Eligibility requires the exact original registry, immutable output
ordinal/token, active fresh allocation, failed controller, original pending
owner and no accepted local execution or allocated worker. The existing planner
still validates all retired mappings.

The existing SSH artifact transport stages a capture helper in a unique temporary
directory, reads the original volume without changing its config, and preserves
all available driver, stack, backend and configured worker files. Missing files
are recorded only from actual inspected absence. Byte hashes, the complete
inventory and native config are rechecked. The immutable source recipe and
original clean execution provenance are bound in both supported phases.

Pre-service verification reuses the original ACK/exited/RUNSTAMP, genuine absence
and approved before-stack source contract. Its new read-only mode attests actual
config preservation before/after, while the old inert-boot mode still requires
restoration. A stopped stack requires every configured worker log, the existing
full clean-stack receipt predicate, native service/process/backend quiescence,
genuine run-file absence and the existing provider prestart-zero manifest
predicate. Actual executed or unquiesced ownership remains retained.

The fsynced immutable receipt reports execution rejection, zero proof credit and
native release unverified. It satisfies only failed-owner retention recovery;
the original pending marker remains as diagnostic evidence. Receipt reuse and
the actual recovery consumer reverify the archive and current native config.
The remaining forty-nine task copies still pass through unchanged primary,
result, worker-coverage and final evidence validation. Ordinary native reaping
and its final provider audit remain mandatory. Completed-task collectors and
validators, task definitions, models, evaluators and execution budgets are
unchanged. This bounded work applies only to retained failures; it adds no live
agent hot-path calls or shared per-agent service.

Owning proof uses the real residual selection, partial-retirement planner,
capture helper, receipt reuse and recovery consumer. The fixture supplies forty-nine
complete normal owner-bound manifests/results; the unchanged normal validators
consume them. Negative controls retain wrong owners, accepted executors,
unconfirmed cleanup, missing worker bytes, changed config/source and actual guest
run evidence. Separate controls bind the read-only preservation mode and keep
the original restoration mode strict. All new controls use the already-selected
`exact_recovery_consumes_runtime_receipt` compact family.

The private packet retains the actual CLI failure, original safe owner/terminal
receipts, unchanged causal test bytes and RED/GREEN logs. An incomplete baseline
fixture layout was discarded before causal credit. Native cleanup from the final
reviewed implementation and original durable publication remain outstanding;
this case remains open and the original benchmark remains rejected.

## Human feedback

No new direct user feedback was recorded for this RCA. Root review instructions
required preserving actual cleanup progress, available originals, inspected
absence, exact source/ownership and independent native closure, without
synthesizing task results, never-started claims, execution seals or acceptance
credit to retire a failed run.

## Reusable lesson

Give failed-owner retention recovery its own truthful capture producer while
keeping completed-execution acceptance evidence and final native release separate.
