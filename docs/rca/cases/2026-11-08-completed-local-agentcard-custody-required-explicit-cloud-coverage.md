---
id: 2026-11-08-completed-local-agentcard-custody-required-explicit-cloud-coverage
date: 2026-11-08
title: Completed local AgentCard stall needed explicit owner closure and current cloud peer coverage
surface: harness
component: deploy_test_completed_local and deploy_test_cycle refresh/verify
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: historical custody historical() required complete original failure, but the completed local aggregate was UNVERIFIED with one proved payment cleanup stall
symptoms:
  - "historical custody: incomplete original failure"
  - "Cloud cleanup failed: payment: TimeoutError"
  - "mapped current peer coverage incomplete, failed, cancelled or stale"
tags:
  - deploy
  - agentcard
  - historical-custody
  - source-binding
sources:
  - commit 5809574d5e0323fb2f285ce34746f955acde7593
  - plan: cli-nov05-cycle attempt 2 initial agentcard-lifecycle a93952459b1f4daeba92d4e6b587249a
  - agent ph74ebnstpp2yzn24y8xhn60d58h7wfd independent completed-local review
repro: python3 scripts/tests/deploy-test-cycle.test.py CompletedLocalMigration
status: open
---

## Problem

The original four-task local aggregate exited 1 and remained incomplete/UNVERIFIED.
Three tasks passed; agent-payment-abandonment ended ERROR with payment TimeoutError.
The native task tree and browser closed, and the original local service owners later
retired while their databases and financial obligations remained preserved. The
ordinary historical cloud route rejected this different aggregate geometry.

## Diagnosis

The original failure is not reclassified. Its source, request, receipt, adapter,
case log and run artifacts remain hash bound. The existing route refusal is
reproduced against copied actual state. A registered migration regression run
against the original cycle dispatcher fails because refresh has no typed
completed_local_proof transition. This demonstrates a missing migration contract,
not the historical cause of the payment provider release stall.

Attribution of the release stall remains separate. This candidate does not claim
that it introduced or repaired the provider's consumed/released imbalance.

## Solution

A narrow completed-local proof closes exact original process/socket ownership
without deleting retained data. It verifies all four original task semantics and
binds only the failed agent-payment-abandonment task to no-retry custody. The
three peers remain mandatory current cloud execution. The old 17-gate contract is
archived in the proof; the replacement 16-gate plan contains ordinary cloud
coverage for every original task. Only the cloud release-stall environment flag
may transition from strict investigation 0 to current ordinary policy 1.

Original failures, native bytes, seven original cloud proof digests and all six
financial obligations remain unchanged. Existing historical custody cannot be
bypassed in mixed state. Both saved and CLI completion refuse missing peers.
Current native source or the unchanged native sealed carry predicate is required;
a consistently resealed foreign-source run is insufficient.

Final local validation: 14 migration controls plus seven existing inherited
custody controls passed (21 total). Actual copied-state replay accepted the
proposal and refresh with seven cloud debts unchanged and refused completion
without current peers. Independent review found and drove permanent controls for
saved verification, mixed custody, exact failed-task scope, original proof digest
and consistent stale-source substitution. A subsequent exact history-only carry
control exposed missing validated binding plumbing: the completed qualification
now accepts only the existing identical-input validated binding, preserving
genuine native carry while rejecting forged carry and changed inputs. No real
cycle was changed. Status stays
open until parent integration and genuine native current cloud validation.

## Human feedback

The user required completing the existing deployment using current ordinary
sandbox policy, preserving every old failure and unpaid amount, without blind
re-execution, financial mutation, false PASS or aggregate coverage inference.
They required all three non-stalled peers to execute currently.

## Reusable lesson

A completed aggregate and its individual task outcomes are different authority
boundaries. Migrate exact task coverage and owner closure explicitly, retain all
original proof digests, and validate final peer execution at every saved-state
verification entry point. A no-retry custody record grants no execution or
financial settlement credit.

### Recurrence: isolated successor inventory after migration

On source 9ed46087 the seven retained native cloud requests each held the original
10 checks while the current ordinary cloud gate held 14. With only the separately
blocked source-authority result stubbed offline, the original isolated_request
refused at `next source/inventory binding`. The unchanged current native source
admission still independently requires a successful native maintenance producer.

The successor protocol now accepts the exact old target inventory only after
revalidating the existing completed-local proof and requiring its four disjoint
semantic task identities to form exactly the current inventory. Source authority
is checked first and is unchanged. Missing/forged mapping, arbitrary additions,
removed peers, changed semantics and modified old inventory refuse. The actual
copied-state control produces seven new-request bindings without any native
admission, cleanup or execution credit. Fifteen focused migration tests pass;
no full cycle or cloud task was launched. The existing synthetic cloud fixture
now declares its real native adapter cwd as the coordinator root so this test
reaches the production request mapping boundary rather than failing cwd checks.
Gate: INTRODUCED for this successor inventory mismatch by the completed-local
10-to-14 migration; this does not attribute the independent maintenance refusal.


## Recurrence — concurrent read-only closure checks took exclusive admission locks (2026-11-08)

Quick51 returned two PASS and two UNVERIFIED gates. Backend structural and
TypeScript never launched: completed_local.physical reobserved the same retired
local AgentCard root for each parallel gate, but quiet acquired its admission
lock with LOCK_EX | LOCK_NB. Four readers therefore contended with each other:
the original native reproduction recorded three BlockingIOError/EAGAIN failures
and one PASS. Cgroup observations showed pids.events max 0 and no OOM events;
this was lock-mode contention, not exhausted execution capacity.

At source 9ed46087f2ba8ea6765953862ae249a93115a945, the same four-thread
physical() replay on the actual retired root reproduces three failures/one PASS.
With the fix it returns four PASS. Add an explicit observation_only keyword to
quiet, selecting LOCK_SH | LOCK_NB only for that mode, and opt physical into it.
Existing reconciliation/cleanup callers retain the default exclusive lock.
The original lock path, read-only open, process incarnation scans, service
manifest checks and physical owner/listener checks remain unchanged. A live
exclusive native worker or cleanup owner still refuses every observation.

Three new owning controls prove four simultaneous readers while an exclusive
writer remains blocked, refusal under an existing exclusive owner, default
exclusive cleanup under a held shared reader, and unchanged live service/process
refusal. Five existing non-signalling LocalCleanup controls also pass. The
exact commands, logs and patch hashes are in
.context/cli-nov08-user-sync/quiet-observation-rca-result.json.
No gate concurrency, deadline, retry, permission, source-state, database or
provider operation changes. The old root is only observed under its existing
lock; all original 607 failures and both actual quick51 failures remain history.
This fixes the observation race, not the separate mapped-inventory boundary or
pending current cloud coverage. Overall case status remains open for those
existing outcome requirements. The bounded assignment is an operational parent
handoff, not a new user quote or financial-cleanup authorization.
