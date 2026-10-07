---
id: 2026-10-07-mixed-cohort-forensics-required-retired-primaries-active
date: 2026-10-07
title: Failed fresh-fleet forensic recovery required normally retired primaries to remain active
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-forensic-retirement.py verify required active clone count to cover every original frozen task
symptoms:
  - assert len(fresh) >= len(clones) >= len(rows)
  - partially retired fresh fleet retains complete originals but forensic retirement rejects its shrinking active clone registry
tags:
  - cloudbench
  - forensic-recovery
  - ownership
  - partial-retirement
sources:
  - commit 9a55d781547780d0c71e6aafa11965eda754a202
  - fleet run 20261007-185005-80376
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_failed_fleet_forensic_retirement_requires_originals_and_provider_absence
status: fixed
---

## Problem

The failed fifty-task Control 9 retained three stopped primaries while forty-seven
had already retired through normal exact-owner cleanup. The original task matrix,
immutable allocation audit, complete sealed normal captures, canonical task results,
runtime owners and guest shutdown confirmations remained retained. Recovery's
generic fresh-fleet archive verifier nevertheless required fifty active clone records.

This case concerns recovery admission only. The original run exceeded its whole-run
cutoff and earns zero acceptance credit. It does not establish the cause of the
two original stack worker-receipt refusals; their first failed process predicate is
still an open diagnosis. No original guest ACK, result, disposition or ledger was
manufactured or changed by this repair.

## Diagnosis

The normal reaper removes an active clone record after publishing its exact terminal
allocation disposition. The task matrix and allocation history deliberately retain
that task. The forensic consumer conflated the active ownership set with the original
task set: first its clone-count assertion refused a smaller active set, then its
per-task assertion demanded disposition `owned`. Deleting originals or recreating
active records would corrupt the producer's legitimate lifecycle transition.

The owning fixture now contains one interrupted owned primary and one normally
retired primary. The same suite also exercises the existing archive builder's
mixed-original union and refusal controls. Its final frozen SHA256 is
`85e54954b9fb4d8e755d8471b3fe0db15a1da36f3d59db6f0bd262b3c582530b`.
The actual unchanged command was:

```bash
/Users/andyprevalsky/Developer/rose-pr1299/agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k 'failed_fleet_forensic'
```

On the original verifier and builder it produced **8 failed, 42 passed in 10.17
seconds**. Valid mixed-lifecycle cases and builder fixture setup failed at the
clone-count assertion; the existing refusal controls remained refused. The same
test and command produced **50 passed in 10.40 seconds** on the repair. This
includes a positive complete-original/native-retired case with collector exit
125; that diagnostic exit adds no rejection gate. Private RED/GREEN logs remain in the isolated repair
workspace's `.context/mixed-forensic-repair/` directory.

The builder boundary was independently reproduced with the repaired verifier:
the unchanged `-k 'failed_fleet_forensic_archive_builder_preserves_mixed_originals'`
command failed **1 case, 3 passed in 3.95 seconds** on the original builder's
`assert kind == "pool"`, then passed **4 cases in 1.56 seconds**. Its inverse
controls require missing raw originals, corrupt normal bytes and foreign owners
to refuse publication. The existing pool recovery suite remains unchanged and
passes all thirteen cases.

Archive searches `forensic retired primary clone registry original evidence` and
`partially retired fresh fleet recovery archive missing clone` found related
registry-retirement, worker-recovery and serialized-retirement cases. Their
solutions and human feedback were reviewed. Those cases do not exercise this
consumer's complete-normal-primary/mixed-fleet domain, so this is a relative,
not an asserted recurrence of those fixes.

Reference comparison: OpenClaw's `src/agents/bash-process-registry.ts:56` retains
completed process history separately from its running index; `:170` separates
visible record removal from live process activity. Hermes's
`gateway/lifecycle_ledger.py:1` retains durable lifecycle evidence after exit.
Claude Code's `src/utils/cleanupRegistry.ts:14` unregisters completed owners.
These references agree on separating history from active ownership, but none
implements Fly Machine/volume forensic admission. The optional local Codex
reference clone was absent; no behavior is attributed to it.

## Solution

The verifier accounts separately for active clones, normally retired primaries,
normally retired workers and never-allocated attempts. A retired primary qualifies
only with its exact immutable fresh-clone audit, expected source and machine index,
original ordinal owner, absent pending transfer and complete
original stopped-stack capture. The shared status producer's manifest code validates
every required stack/backend/worker file and original clean token. The ordinary
result validator checks the unchanged task, mode and frozen execution provenance.
The archived manifest and all archived capture bytes must match that original seal;
the canonical result must remain byte-identical to its original captured result.
Unindexed worker evidence is refused and existing worker terminal/native validators
still apply to every indexed worker.

The existing `cloudbench-build-interrupted-pool-archive.py` now accepts a fresh
cohort through its same documented registry/capture-directory arguments. It
forms generic-v1 task rows from complete normal captures and the supplied exact
stopped-original tars, preserves full original driver logs and both source files,
and includes complete normal worker capture bytes. Missing original ACKs and
driver PID files remain explicitly missing. It never changes an original capture,
audit disposition or ownership latch, refuses an existing destination, and fsyncs
the newly produced private archive and manifest before publishing them. The same
supported `scripts/run-bench --recover-stale-owner <exact-owner>` consumes this
archive through its existing generic-v1 verifier and exact native reaper.

An absent primary and an absent exact volume qualify. A provider-retained volume
qualifies only when its original terminal disposition agrees with the fresh native
`pending_destroy` or `destroyed` state and the exact volume has no attached machine.
Even archive-only admission refuses a retired primary whose native Machine or
nonterminal volume reappears. Active interrupted guests retain their existing
provider/worker/archive checks and normal exact-owner reaper; they cannot borrow
the normal-capture branch. Missing, corrupt, foreign and incomplete originals,
foreign source/task identity, active clone records and uncertain native ownership
continue to refuse. Every resulting receipt has `proof_credit=0`.

This unifies stopped-stack integrity with the existing producer instead of creating
a second weaker normal-capture validator. Frozen matrix validation is done once per
recovery, and per-primary checks stream bounded original files. At ten thousand
agents this remains linear in the failed owner's existing records and retained
bytes, off the execution hot path. It adds no provider calls, new polling loop,
unbounded concurrency, shared execution lock or paid proof stage.

The fixture is already selected by `scripts/tests/benchmark-live-results.test.py:46`
and the Cloud Benchmark Lifecycle suite in `scripts/test.sh:344`. The standard
deploy command invokes the same owning dependency-sync suite. No new gate or
timing assertion was introduced.

## Follow-up: numbered-worker absence provenance was missing in the fresh builder

PR1440's exact-source review exposed a producer/consumer gap in the same
fresh-capture builder. Its earlier mixed-fleet fixture used one worker, so it
never exercised the verifier's existing numbered-worker absence contract.
The first bad boundary was the builder's missing-path list: it retained absent
numbered paths without their required `worker-log-absence-original.json`.
The canonical forensic consumer already requires that exact machine, service
status and missing-path record; its validator was unchanged.

The existing builder control now uses a three-worker original capture with
`worker.1.log` absent and `worker.2.log` present, alongside a normally retired
primary. It also supplies an existing absence record with deliberately different
JSON whitespace and requires those original bytes to survive unchanged. The
missing-record case failed on the unchanged source with
`filename 'fixture-task/worker-log-absence-original.json' not found`.
The frozen command selecting this builder and the monitor's owning control
failed 3 cases, passed 11 in 4.06 seconds; the identical test bytes passed all
14 in 2.53 seconds after the two producer fixes.

Derive the numbered absence record from the same bounded loop that records
missing worker paths. Publish it only when the original capture lacks it;
otherwise preserve the supplied original bytes for the existing strict consumer
to validate. This record discloses absent logs; it does not invent a clean ACK,
repair a missing log, mutate a source capture or certify an original run. The
raw-tar hash, audit bytes, missing driver/ACK fields, mixed retirement and
missing/corrupt/foreign refusal assertions remain in the same control. Existing
`failed_fleet_forensic` deploy selection discovers both new cases.

Archive searches were `worker-log-absence-original missing numbered worker
archive` and `fresh capture numbered worker log missing provenance`. This is a
recurrence of this producer/consumer contract; the cache-policy provenance case
is a relative. Golden references were reread: OpenClaw
`src/agents/bash-process-registry.ts:56,170` separates retained history from
live records; Hermes `gateway/lifecycle_ledger.py:1` retains diagnostic exit
history; Claude Code `src/utils/cleanupRegistry.ts:14` owns unregisterable
cleanup; Codex `codex-rs/core/src/unified_exec/async_watcher.rs:183` at
`3342ee8c` waits for terminal monitor evidence before classification. None has
the Fly original-worker-log absence protocol. Rose's existing strict consumer
is the source of truth for that record. The repair adds one bounded list in the
existing per-capture pass, no extra fleet scan or execution hot-path work.
Private unchanged-test/source/log bindings accompany this batch. This proves
the owning mechanism only; all original campaign acceptance remains unchanged.

## Human feedback

The user required a general mixed-cohort repair, immutable original evidence,
zero retroactive acceptance credit, exact provider/process/Machine release and
preserved missing/corrupt/foreign refusal controls. Independent review must precede
push. A stale internal status alone must not reject an independently proven exact
retirement, and missing graceful receipts must never be replaced by forged ACKs.

## Reusable lesson

Separate original task history from active ownership, and admit retired history only through its exact original evidence and verified native terminal state.
