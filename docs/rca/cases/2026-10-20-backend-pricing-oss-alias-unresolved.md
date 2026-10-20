---
id: 2026-10-20-backend-pricing-oss-alias-unresolved
date: 2026-10-20
title: OSS alias missing from backend pricing lookup while Python execution succeeds
surface: cross
component: rose-pool-pricing
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Candidate unproven: backend poolForModel omits rose-labs/rose-1-oss before modelPricing literal-catalog lookup
symptoms:
  - [ModelPricing] No pricing found for model: rose-labs/rose-1-oss
  - HTTP 201 with missing create-time model pricing metadata
tags:
  - pricing
  - pool-registry
  - model-alias
  - open-triage
sources:
  - PR #1552
  - commit 64e5cc2dd83dfc346797b97e7c0f5fd749713250
  - agent 915ab997-c174-4297-80ac-15347120342f
  - benchmark run 6d381188-2d83-46d3-a2d5-2cfb460bc173
  - agent ae879bf0-c5a2-41df-a7f8-a46d8d4d5d60
  - task browser-biometrics-webdecoy
repro: none-recorded
status: open
---

## Problem

`browser-pricing-warning-triage.txt` records backend.log:487 at
2026-10-20T02:11:51.581Z, request 82d4f8224a31, under source-worktree
`.context/benchmarks/1792462236-438247-20002/`. Agent creation returned HTTP 201
in 466 ms. The worker independently resolved pool pricing and saved nonzero usage.
The affected task later passed in 205.6 s; the local producer card now reports that
nine-task batch 9/9 passed. These are existing local results, not new runs or proof
of pricing correctness; outcome_sha256 is null. The exact warning is nonterminal.

## Diagnosis

Code read: back-end/src/providers/rose/pools.ts:20,51-119 lacks the OSS pool/alias,
while agents/providers/rose/legacy_adapter.py:40 and pools.py:220-230 support it.
modelPricing.ts:120-155 therefore reaches literal-model lookup and null pricing.
Create metadata can remain null through agentCreateMetadata.ts:21-28 and
repoMutations.ts:155-156. That persisted state is source-traced, not a captured DB row.
Python runtime pricing is separate and its success does not repair the backend registry.
Missing evidence: raw catalog response, stored pricing fields, and an executed
owning-boundary regression/fix pair. Do not claim corrected pricing or all-cost loss.

Two archive searches (literal ModelPricing/no-pricing; behavioral alias/pricing and
registry drift) found no matching case. Full query patterns/results are retained in
incidental-archive-searches.json. No recurrence established.

Archival preparation only, based on the complete read-only triage reports in
`.context/rca-915ab997/`. Runtime source is
`.context/rca-915ab997/browser-deploy` at the commit above. No local reproduction,
new test, benchmark, provider call, implementation, credential repair, or deployment
was performed for this case. `classification: unresolved` and `repro: none-recorded`
are intentional. Parent owns archive indexing/validation and deployment decisions.

## Solution

No fix applied. Proposed next proof: replay the captured catalog through the existing
backend pricing/agent-create boundary and assert supported alias parity with Python,
while retaining unknown-model rejection and actual-provider billing semantics.
Do not invent zero pricing, change the benchmark, or waive deploy gates.

## Human feedback

None recorded for this incidental warning. The parent investigator scoped the
archival assignment to existing evidence and case files; those assignment limits
are not a new standing user prohibition on implementation or verification.

## Reusable lesson

Trace pricing aliases through each registry and preserve task success separately from unresolved pricing metadata.
