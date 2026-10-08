---
id: 2026-10-08-exact-recovery-omitted-terminal-release-projection
date: 2026-10-08
title: Exact fleet recovery retired resources without publishing terminal release
surface: harness
component: benchmark-live-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: recover_exact_stale_fleet_owner returned after registry retirement without terminal projection or publication
symptoms:
  - fifty shutdown ACKs and no bench-e2e.finished-epoch markers after exact recovery
  - terminal Hub group retains forty-eight teardown phases and two null phases after native release
tags:
  - exact-recovery
  - benchmark-hub
  - release-projection
sources:
  - fleet run 20261007-224256-41245
  - commit ccc4ac7f91375a8c6e7b30b98f35b226784a9713
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_exact_recovery_consumes_runtime_receipt_publishes_audited_release
status: mitigated
---

## Problem

C11's supported recovery completed with exit zero and an independent native audit
proved all fifty Machines and fifty Volumes absent, no claims and no registry.
The original release clock was 1791419757. The later canonical grouped API still
had one fifty-task group, its original timestamp, thirty-one passes and nineteen
failures, with forty-eight teardown phases and two null phases. All fifty guest
shutdown ACKs existed, but no task had an end-to-end finish marker. The last live
publication ACK preceded native release. Browser DOM was not verified.

## Diagnosis

The source-to-sink path is exact recovery → native audit → registry retirement →
release markers → terminal aggregation → ordinary Hub upload. Normal EXIT cleanup
ran the final three operations; maintenance recovery returned before them. A
second aggregation gap skipped lifecycle metadata for missing-run INFRA rows.
Resource truth was correct; its terminal publication contract had two owners.

Archive searches were `recovery lifecycle teardown terminal projection publication`
and `bench-e2e.finished-epoch exact recovery final release missing Hub`. The
October 4 direct-fleet live-publication and September 9 terminal-source cases are
relatives: they cover live transport and normal finalization, while this boundary
is the maintenance exit after exact release.

The actual recovery function, aggregator and ordinary Hub client against a joined
loopback server reproduce the omission. The identical command
`python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k exact_recovery_consumes_runtime_receipt_publishes_audited_release -rA`
failed on 01b4173 with seven failures and one pass in 6.53 seconds, then passed all
eight unchanged controls in 5.55 seconds. The two positive controls fail first on
missing original release markers. Negatives cover failed audit, foreign ACK,
clock mismatch, wrong owner, unsealed source and upload rejection. An early exact
release clock remains unchanged. Sixteen related normal controls pass; their
extracted-loop fixtures now include the shared helper and original audit inputs.
A pure read-only join also accepts C11's actual sealed audit, source-copy digest,
original task list and live ACK, retaining its original controller exit code one.

## Solution

Share the release-marker producer and existing terminal finalizer with exact
recovery. Successful recovery, including an already-retired registry, binds the
complete immutable audit to its original run-local copy and requires exact owner,
run, task-list and prior self-managed publication identity. It writes missing
finish markers atomically from the original audited epoch, preserving existing
clocks. Clockless historical receipts remain unknown; recovery invents no clock.

Recovery refreshes only lifecycle fields in the complete original terminal
bundle, preserving verdicts, task bodies, timestamp, group metadata and counters,
then uses the ordinary final upload. All requested INFRA rows receive lifecycle
metadata without changing their task result. A failed upload reports failure
separately from already verified physical release. Historical lifecycle verdicts
and publication-failure fields are not rewritten. Step 4s and the existing
benchmark-live-results deploy selector discover the new eight controls.

Claude Code's `src/tasks/LocalShellTask/LocalShellTask.tsx:224` awaits the common
flush/cleanup owner before updating terminal state from the original exit code;
`:515` owns that cleanup. Rose converges on that ordering and outcome separation.
No exact cloud-maintenance analog is claimed; the other reference clones were
absent in this checkout and were not installed during this bounded repair.
At ten thousand agents this performs one bounded per-fleet terminal audit scan
and one existing upload, without a per-task publisher or new polling lane.

This is mechanism proof only. C11 remains failed with zero credit: first image to
actual release was 7477 seconds against its immutable historical 3600-second
budget. No canonical task rerun, original result rewrite, original publication or
provider mutation was performed by this repair. Production rollout and actual
post-recovery publication remain the parent deployment owner's responsibility.

## Human feedback

The user required usable end-stage progress without aggressive inner timing gates,
compact regressions in normal deploy, and preservation of failed original evidence.
After a user pause, they explicitly resumed the goal with INFRA-only automatic
retry, a ninety-minute campaign E2E budget and the unchanged twenty-minute task
window. Those new rules do not retroactively change C11's budget or credit.

## Reusable lesson

Publish terminal cleanup metadata through the same audited release owner on normal exit and exact maintenance recovery while preserving the original task outcome.
