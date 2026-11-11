---
id: 2026-11-11-synthetic-controller-pids-collide-with-host
date: 2026-11-11
title: Synthetic retired controller IDs collide with live host process IDs
surface: harness
component: deploy-test-cycle campaign reconciliation fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Synthetic campaign controller IDs310001 through310014 enter the production host PID and PGID census
symptoms:
  - "ValueError: native cleanup: old controller still active"
  - test_reconciled_failed_successor_rejects_untrusted_authority_atomically
  - test_reconciled_failed_successor_renews_at_repair_boundary_without_credit
tags:
  - fixture-isolation
  - process-identity
  - flaky
sources:
  - PR #1682
  - commit b4cfdc9d11219ba2ae9a76e5d8459670fd36ef1e
  - task native run https://github.com/Rose-Ai-Labs/rose/actions/runs/42958420725
repro: scripts/tests/deploy-test-cycle.test.py Cycle.test_reconciled_failed_successor_renews_at_repair_boundary_without_credit
status: open
---

Status: canonical NOT_INTRODUCED post-merge handoff pending; tested candidate remains unapplied. Native post-fix run has not been performed.

## Problem

PR1682 b4c round12 structural native run42958420725 recorded deploy-test-cycle FLAKY: original499 tests had2 errors; the built-in single retry passed. Both original errors are in the initial isolated_campaign_state reconciliation for test_reconciled_failed_successor_rejects_untrusted_authority_atomically and test_reconciled_failed_successor_renews_at_repair_boundary_without_credit. The actual error is `native cleanup: old controller still active`. Original artifact log SHA2567f132e29f507c0ecacc9bc7c7d55a4bb7f7d0dba7f8c399e69e90c9b98d3f4fb; excerpt native-original-errors.log retained here.

## Diagnosis

Fixture campaign_recon_state invents controller PIDs310001..310014 and binds these integers into native run IDs and campaign job metadata. isolated_execution correctly checks the real host ps PID/PGID census to refuse a still-running controller. Invented low IDs can instead identify unrelated processes on a busy runner. The original guard requires PID>1 and no matching non-Z PID/PGID; the fixture satisfies PID>1 and is otherwise entirely synthetic. Thus the native error establishes a collision, though the original ps census and individual colliding process identity were not logged and cannot be reconstructed.

Local repro.py feeds a deterministic ps row310001 while retaining real production cleanup logic and all fixture receipts. The original first test fails0.239s, second0.259s at the exact native boundary. The first test also fails on585 baseline0.254s. Candidate moves the entire synthetic campaign ID range above Linux PID_MAX_LIMIT while retaining signed32-bit bounds and all identity relationships. Both original tests pass0.865s/0.824s with the same supplied row. A registered regression retains the actual census, appends the unrelated original low PID and proves acceptance, then supplies the fixture's actual PID and PGID separately and verifies refusal plus unchanged state. Existing admission and cancelled-parent negative suites also pass.

Compared585 to b4c, ASTs of campaign_recon_state, isolated_campaign_state, successor fixture, both failing tests and runtime isolated_execution are identical (baseline-function-comparison.json). The defect predates b4c. This attribution does not waive the assigned repair or native validation.

Archive searches: literal `old controller still active`, behavioral `synthetic PID collision`, and source search for synthetic PID/host collisions. Related case2026-10-26-fake-guest-proc-namespace-included-host-siblings shares fixture/host namespace confusion but has a distinct adapter boundary; not a recurrence of its bounded_proc implementation.

## Solution

Only the test fixture changes: stable impossible host PIDs2147482001..2147482014; update dependent negative-test metadata and lookup; add the host-collision/owned-live regression. Keep real ps observation and production fail-closed guard entirely unchanged. Candidate is in ignored context and is NOT applied while native source consumers are active. The candidate full local suite and independent review are complete; fresh post-application native validation belongs to the post-merge repair.

## Human feedback

The user requires completing PR1682 deployment and permanently excluding the mass-agent test from future deploys. This separate test-fixture repair does not touch mass execution, cache data, timeouts or test acceptance.

## Reusable lesson

Keep synthetic process identities outside the host PID namespace while explicitly testing refusal of genuinely live owned identities.

## Local full-suite evidence and scope

The loaded candidate module completed500 tests in196.567s with native exit0, quiescent true and no orphaned or remaining children. Its original __file__/ROOT keeps inherited self-subprocess cases on the original frozen path; this is not post-application native qualification. Independent review verified exact candidate0e5a076ae798cbd554d7f495eba2bf14408fb517dc5b891b39f40bddddc08a60. Both original failing cases have separate before/after results. The active assignment is finishing deployment with a mass-agent selection exclusion; this additional pre-existing fixture failure was not the assigned repair. Under the controlling deploy failure policy, mark only the two observed tests, keep them executing, preserve their outcomes, and dispatch the full repair packet only after merge. The current PR does not apply the candidate PID fix or change the runtime liveness guard.

The deploy change adds per-case markers only to the two observed failures and corrects attribution-only suite-to-case binding using the original native receipt, source registry, log hash and complete failed-case list. Global case matching and quarantine release streaks remain unchanged. The proposed synthetic-PID fix is preserved for the post-merge repair; it is not included in this deploy patch.
