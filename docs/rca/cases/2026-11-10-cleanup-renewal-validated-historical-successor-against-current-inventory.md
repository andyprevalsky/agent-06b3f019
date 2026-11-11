---
id: 2026-11-10-cleanup-renewal-validated-historical-successor-against-current-inventory
date: 2026-11-10
title: Cleanup renewal validated a historical successor against the current expanded inventory
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: clean_isolated_successor compared the sealed thirteen-case successor contract digest with the current fourteen-case gate before reading the historical request
symptoms:
  - "DEPLOY_CYCLE BLOCKED: native cleanup proof refused: native cleanup: successor contract"
  - "browser-auth-saved-password-retry"
tags:
  - deploy
  - cleanup
  - historical-contract
  - inventory-extension
sources:
  - PR #1912
  - commit 2d0a00cb52caccb8e090ff4e1f3597769f3b7986
  - plan:.context/deploy-pr1896-continuation/isolated-successor-contract-candidate/handoff.json
  - plan:.context/deploy-pr1896-continuation/isolated-successor-contract-candidate/stability-result.json
  - plan:.context/deploy-pr1896-continuation/integrated-owning/isolated-renewal2d0.log
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_clean_historical_successor_renews_after_added_inventory_without_credit
status: open
---

## Problem

Normal isolated-cleanup renewal for original token
f3f328112d8e45bf8c0f57248e35ccf5 refused with the exact first symptom above.
The latest complete successor was the retained attempt8 failed-gates smoke
receipt, with seven active cases PASS and six historical skips. Its original
13-case request, result, cleanup references and source remain immutable.
The current plan added only browser-auth-saved-password-retry to this gate.
All other gate fields stayed identical.

The normal CLI reproduction is:

```bash
python3 scripts/deploy_test_cycle.py reconcile \
  --root /home/boxes/rose \
  --plan .context/deploy-pipeline/plan.json \
  --state-dir .context/deploy-pipeline \
  --occurrence f3f328112d8e45bf8c0f57248e35ccf5 \
  --proof .context/deploy-pr1896-continuation/integrated-owning/isolated-proof-profile2d0.json
```

This argv is reconstructed from the actual CLI parser, retained paths, token
and proof; the original log retains the refusal but not its full shell argv.
It was not rerun against live state by this RCA worker.

## Diagnosis

The current full-gate digest is
`a01e7d6617d0dfc8a3082a28a09f5dc28e4ce99702cc8af4b8d0dff76bdd70bd`.
Filtering its ordered checks to the exact old request checks-plus-skips produces
`7b5911eb9da076f899f658f2eb0cd8ae6ebbbc90488cbf8773277042b08f914c`,
exactly the old successor execution_binding.contract_digest. Thus this is a
proved contract-lifetime mismatch, not missing release evidence or an
unexplained environment failure. Gate: INTRODUCED for this 13-to14 inventory
integration; this says nothing about attribution of the original native failures.

The clean renewal helper required the historical execution contract to equal
current inventory, although isolated_request already supports the original
inventory being a subset of a fresh full current request. Renewal is required
before that fresh request can launch, so the two contracts made progress
impossible after a legitimate inventory extension.

Archive searches: `successor contract isolated validation renewal` and
`historical gate inventory current cleanup contract`. The closest case,
2026-11-09-native-cleanup-required-probe-success-for-release, concerns probe
success versus physical release and the incomplete-successor branch. It is a
related consumer but a distinct first-bad predicate, so this is a proposed new
case rather than claiming a recurrence of that lifecycle diagnosis.

## Solution

The ignored candidate changes only clean_isolated_successor. On contract drift,
authenticate the historical attempt source, phase and nonstale status. Require
the historical request inventory to include every original-debt case and be a
subset of the current gate. Reconstruct the old gate by filtering current
ordered checks, then require its entire canonical digest to match the sealed
successor binding. Every noninventory gate field and old check order remain
cryptographically bound; unreconstructable recipe, environment, command,
selection or inventory changes refuse. No guessed historical recipe is added
when both old request and gate omit worker_recipe.

Run the original native receipt, request, result, evidence hashes, ownership,
clock and cleanup checks against this authenticated historical inventory.
Keep current environment equality, original proof/source/retained-owner guards,
and the outer renewal validation_source binding. The fresh request still must
cover all14 current cases. No old PASS/SKIP is imported as new-source credit;
no financial or forensic debt is cleared or broadened.

Simplification: reuse the existing gate representation and digest instead of
introducing a new historical-gate witness/proof variant or shadow plan store.
The exact full digest fails closed if that representation cannot reconstruct
the historical contract. No prompt, LLM-visible schema, model or timeout edit.
Golden reference: not applicable (no approval-gated hunk).

The same three new registered-method candidates first gave two passes and one
error at successor contract on unchanged ROOT producer bytes, then all three
passed on the candidate. Five existing neighboring methods passed unchanged.
The same frozen producer and unchanged three-method command then passed five
consecutive runs (15 method executions), each native0, quiescent, no orphans,
TERM[], KILL[], remaining[] and errorNone. Initial helper-path harness errors
are separately retained and are not causal RED evidence. Original test methods,
assertions, native files and time/concurrency limits are unchanged.

Status remains OPEN: the minimal producer and registered regression changes are implemented. Independent scoped review cleared the exact patch, and the three new tests passed five consecutive unchanged runs. Canonical owning validation, normal live renewal and full new-source deployment gates remain required; no cleanup, full-source or deployment PASS is claimed.

## Human feedback

None recorded specifically for this incident. Parent/reviewer coordination is
not human feedback. Standing no-waiver, no-timeout-relaxation and Freedom
instructions remain in force.

## Reusable lesson

Authenticate a cleanup successor against its sealed historical execution contract while requiring fresh execution to cover the complete current inventory.

Independent review: plan:.context/deploy-pr1896-continuation/isolated-successor-contract-candidate/independent-review.json (SHA ec07c6b4fc6b46e509731261633e5852cbed4fd0b82995d54645a242b429a874).
