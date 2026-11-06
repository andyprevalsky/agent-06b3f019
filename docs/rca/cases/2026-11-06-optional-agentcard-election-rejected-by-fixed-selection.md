---
id: 2026-11-06-optional-agentcard-election-rejected-by-fixed-selection
date: 2026-11-06
title: An explicit optional AgentCard election was rejected by the staged selection guard
surface: harness
component: staged-deploy-selection-and-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_cycle.py refresh rejected every removed gate before recognizing the planner's explicit AgentCard opt-out
symptoms:
  - "repair cannot silently remove originally selected gates"
  - "explicit AgentCard opt-out"
  - "cleanup remains unverified; retaining its recovery authority"
tags:
  - deploy
  - optional-coverage
  - custody
sources:
  - PR #1708
  - commit 429d9ac6f9520597ba4145df096e7c37fae1d879
  - task .context/rca-browser-4f77/agentcard-election-native-replay-streamed.log
repro: scripts/tests/deploy-test-election.test.py
status: mitigated
---

## Problem

The planner supports the documented operator election to omit the optional local AgentCard lane. An existing staged cycle could not import that explicit election: `refresh` rejected its missing gate exactly as it rejected an unexplained reduction of required coverage. Restarting the cycle would lose source/failure/custody history and was not an acceptable workaround.

The triggering browser deployment had already executed the optional lane: three payment tasks passed and abandonment ended ERROR. An organization authentication rejection changed the purchase to FUNDING_RECLAIM_FAILED; the existing owner watchdog subsequently deleted the database despite failed-retained bookkeeping. The remaining captured funding state does not satisfy the standing HELD release-stall predicate. Those payment, authentication, retention and historical-ledger gaps remain open; this selection repair does not fix or waive them.

## Diagnosis

Gate: NOT_INTRODUCED relative to the browser application changes. The unconditional selected-gate guard was already on main. The owning path is documented optional election → planner SKIPPED omission → refresh's selected-set guard. The guard discarded the distinction between an explicit authorized optional selection and silently losing required checks.

The permanent native test with valid disjoint worker ports failed before integration with `ValueError: repair cannot silently remove originally selected gates`. The same test passes after integration. An earlier invalid-port fixture failed at isolation validation and is retained separately; it is not causal evidence for this defect.

The related archive searches covered explicit opt-out/selected coverage and retained cleanup authority. Existing payment-stall and pre-admission cleanup cases constrain resource handling but do not authorize changing this failed task's verdict.

## Solution

Recognize only the existing planner's exact AgentCard omission during quiescent refresh. Keep every other selected gate, check and execution contract unchanged. Preserve original attempts, native cases, receipts, source clocks and cleanup owners. Record the omission separately with zero task or cleanup credit; never convert UNVERIFIED into PASS or a delegated waiver.

For an already admitted incomplete lane, require the original native request/result/receipt and full task membership, unchanged original-source payment and physical-observation policies, sealed/deleted provider roots, exact captured pending obligations, a read-only matching provider observation, verified private archive/member recovery, explicit known loss and continuing accountability, and fresh independent physical closure. The original failed benchmark cleanup marker remains failed. Reject assigned-repair substitution, arbitrary removals, mismatched identity, changed evidence and active resources.

A read-only replay against the actual preserved occurrence passed without changing canonical state, original outcomes or owners. Final completion still requires a different devbox's explicit, hash-bound operational custody acceptance and independent archive recovery; an archive or a promised handoff alone is insufficient. That acceptance provides no task, release, refund or settlement credit.

The native run is projected with a streaming JSON reader, excluding messages and raw logs while binding exact archived bytes. This is an explicit operator transition, not application polling; its work scales with the one optional run and its evidence, not every production agent.

Golden reference: not applicable (operational selection and custody only; no product prompt, agent trajectory or runtime schema change). Full final-source validation and deployment remain required.

## Human feedback

No new user instruction was received for this failure. The existing deploy workflow expressly permits an operator's AgentCard election, requires original failures and liabilities to remain visible, and forbids creating replacement cards merely to replace a confirmed release stall.

## Reusable lesson

Distinguish explicit optional coverage decisions from native task results and retained resource obligations without resetting their history.
