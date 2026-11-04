---
id: 2026-11-03-admin-health-sol-ledger-identities-unpriced
date: 2026-11-03
title: Sol ledger identities were absent from API-equivalent cost rates
surface: back-end
component: admin-health-costs
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: currentModelRates receives bare Sol or exact Foundry identity without a matching rate
symptoms:
  - gpt-6.1-sol-gpt input API-equivalent rate 0 !== 2
  - gpt-6.1-sol-foundry counted as unpriced usage despite known model
  - GPT-6.1 Sol OpenRouter cache reads priced at 0.20 rather than 0.10 per million
tags:
  - pricing
  - admin-health
  - model-identity
sources:
  - PR #1634 review 5746689291 comment 4450443008
  - commit ca44d84711aafd6972329ebca7beafa02e75f8b4
repro: back-end/src/tests/blackbox/admin-health-sol-pricing.cases.ts
status: fixed
---

## Problem

The review identified actual ledger identities produced by gpt_auth.py and
foundry.py that the admin-health API-equivalent rate table did not cover.
The same local test on a byte-for-byte copy of current costs.ts failed with
`gpt-6.1-sol-gpt input API-equivalent rate: 0 !== 2`. Its tokens were counted
as unpriced. Existing OpenRouter Sol cache-read multiplier was also stale.

## Diagnosis

Subscription producer appends `-gpt`; normalization strips it to bare Sol.
Foundry producer appends `-foundry`, which normalization intentionally retains.
Neither resulting key existed. The separate OpenRouter key existed, but used
the generic 10% cache-read multiplier instead of Sol 6.1's 5%.
This is API-equivalent repricing, not actual billed subscription cost.

Archive searches: `admin health missing cost model` and
`pricing normalization token suffix`. The open October20 OSS pricing-alias
case is related but owns a different create-time pricing lookup, not this
admin-health repricer; no exact recurrence established.

## Solution

Private candidate adds explicit bare and Foundry Sol keys, keeping provider
identity instead of broadly stripping suffixes. All Sol entries use standard
$2 input, $0.10 cache-read, $2.50 API-equivalent cache-write, $10 output per
million. Public source checks on November3: OpenAI model documentation,
Microsoft Foundry September announcement, and OpenRouter Sol provider table.
These flat standard short-context figures intentionally retain the existing
report contract; speed/long-context adjustments and actual invoice calculation
are outside this change. The zero-LLM-cost scenario is unchanged.

Exact command: `/home/boxes/rose/node_modules/.bin/tsx /project/rose-speed-comparison-20261028/nov3-review-fixes/costs/repro.ts`.
Before exit1; same test after candidate exit0,20 route/bucket cases plus unknown
Foundry control. Candidate registers the case with normal admin-health blackbox.
The full owning-suite result below completes shared-source validation of this repair.
Golden reference: not applicable (no approval-gated hunk).

## Human feedback

User instructed completion of the deployment and correction of blocking issues.
No price-specific instruction or threshold exception was requested or inferred.

## Reusable lesson

Cover every actual ledger model identity with explicit API-equivalent rate tests while preserving unknown-model coverage loss.

## Integrated verification

The same normal three-domain owner command failed on the original runtime and passed after the repair: admin-health9/9, maintenance-settings7/7 and maintenance15/15. The API-equivalent regression is part of the normal admin-health suite. See `nov3-review-fixes/owning-results.json` for exact artifacts. Full release gates remain required.

## November 3 recurrence: explicit Luna Foundry identity

Final review5748355636 finding4451807258 exposed the sibling missing key `gpt-6-luna-foundry`. The actual cost calculation reported input0 instead of0.10 for one million tokens. The explicit key now uses standard short-context API-equivalent input0.10/output0.50/read0.01/write0.125. Microsoft publishes input/output/read; write is the shared documented API-equivalent convention, not verified regional invoice pricing. Unknown Foundry identities remain unpriced and the zero-LLM-cost scenario is unchanged.

The same actual-module test failed before and passed after. The permanent existing admin-health case covers all four buckets. Exact private before/after receipts and source hash are in `nov3-final-review-fixes/backend/manifest.json`. Integrated owner validation is recorded below when complete.

Integrated verification: admin-health, code-sessions, cli-login and repo-onboarding all passed in the same four-domain command (artifact1793691277-2805897-17819). Existing six-process Kernel local-DB unit passed with one shared remote allocation. Backend typecheck and scoped lint passed. Full new deployment gates and production verification remain pending.
