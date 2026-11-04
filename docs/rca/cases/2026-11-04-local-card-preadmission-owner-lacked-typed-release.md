---
id: 2026-11-04-local-card-preadmission-owner-lacked-typed-release
date: 2026-11-04
title: Local Card startup failure retained a logical owner after native stack cleanup
surface: harness
component: staged-deploy-local-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: incomplete native Card producer retained launch ownership but typed local reconciliation accepted only the backend producer
symptoms:
  - run.sh exited early with code 143
  - local cleanup owned local backend binding
  - native cleanup owner prevents re-execution
tags:
  - deploy
  - agentcard
  - cleanup
  - ownership
  - preflight
sources:
  - PR #1662
  - commit b9a1f743152e29cb6626ed33fdce88d24a919ba1
  - agent occurrence 5212285ae71d47109d967297a7485d57
repro: python3 scripts/tests/deploy-test-cycle.test.py CardPreflightCleanup.test_never_admitted_card_releases_launch_only_preserving_native_failure
status: open
---

## Problem

Round35 agentcard-lifecycle stopped in local.py wait_for_services when run.sh exited143. The benchmark owner remained not_started with no PID, identity or token; no run.json, report-card.json or task-result inventory exists. Native stack cleanup is clean. The coordinator nevertheless retained a logical native-producer owner because the aggregate result was incomplete. Original native result remains UNVERIFIED, exit1, completefalse; this report does not claim task success or payment settlement.

## Diagnosis

Gate: UNKNOWN for the original startup interruption. No historical watchdog-PID ownership proves its signal cause. This case concerns only the separately reproduced launch-release contract gap: the existing typed local reconciler rejects this genuine local Card pre-admission shape as an unsupported backend binding. It must continue to refuse admitted tasks and incomplete cleanup.

Compared revisions: frozen b9a1f743152e29cb6626ed33fdce88d24a919ba1 versus the private helper candidate. No baseline-to-head attribution for the startup143 failure is established. Archive searches used “local cleanup owned local backend binding” and “not_started Card cleanup owner pre-admission”. The cloud campaign reconciliation case is a relative at another producer boundary, not proof of this cause or a recurrence of its released-resource contract.

The identical registered owning command above fails on b9 with “local cleanup: owned local backend binding” and passes after the narrow extension. Eleven registered Card/backend controls pass. Independently replaying the exact saved native receipt also refuses before and validates eligibility after; all nine original file hashes remain unchanged. Because round35 was still active during replay, no canonical reconciliation or re-execution was performed.

## Solution

Extend existing local-supervisor-cleanup-v1 without changing its kind or adding a persistent protocol. Require the bound local Card command, current recipe/contract/admission root, original request/result/receipt identity and hashes, genuine native case log and result, the exact startup error, and its owned run directory. Require literal not_started/no-PID benchmark custody and absence of all task artifacts. Bind the clean schema2 stack receipt to the original PID, birth, native identity and token; refuse a live owner. Require stopped owned services, no actual recorded listener, and current root process/admission quiescence.

Reject executed or unknown benchmark custody, foreign/pending stack receipts, changed native bytes/source identity, active owners, root processes, listeners and held admission locks. Keep credit_granted=false and every original case/outcome/receipt/debt/history byte unchanged. A later source may release this original owner under an unchanged gate contract but obtains no PASS from it. Full native validation and the original interruption attribution remain open.

Private proof and logs are in /var/tmp/pr1662-b9-card-preflight-cleanup; native-proof.json seals the original request, adapter, coordinator receipt and native owner/result/stack evidence. The original run is /var/tmp/pr1662-worker-seed-cache-decision/.context/benchmarks/1793762283-507146-16052. Golden reference: not applicable (infrastructure-only ownership reconciliation).

## Human feedback

Parent required a private minimal extension, genuine owning RED/GREEN, rejection controls and original UNVERIFIED preservation. No generic incomplete-worker bypass, provider/payment action, source/state mutation, gate launch, retry or financial waiver. Healthy independent gates continue. Preserve Freedom and all protected instructions.

## Reusable lesson

Represent never-admitted producer custody separately from admitted task cleanup, and release launch ownership only from native identity-bound closure without rewriting the failed execution.
