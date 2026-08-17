---
id: 2026-08-16-untyped-card-creation-failed-rewritten-as-funding-in-progress
date: 2026-08-16
title: Untyped Org MCP card_creation_failed was rewritten as company funding-in-progress
surface: back-end
component: purchases-funding-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: classifyFundingResumeFailure + providerErrorFromUnknown — untyped create_card card_creation_failed after providerCallStarted is treated as ambiguous and rewritten to agentcard_company_funding_in_progress
symptoms:
  - create_card failed: card_creation_failed
  - AgentCard company funding outcome is not confirmed; retry this purchase shortly
  - Payment funding is delayed
  - tree stalled silent for 514s (threshold=510s)
  - POST /api/purchases/mint -> 409
tags:
  - agentcard
  - funding
  - mint
  - fail-closed
  - payment
  - stall
sources:
  - agent 500c444d-a5ff-4a35-9b08-3b888489f3df
  - commit f50686598114972a925a47c84a7029aad337353d
repro: back-end/scripts/rca-card-creation-failed-repro.ts
status: fixed
---

## Problem

After payment approval on `agent-payment-production-purchase`, mint repeatedly
returned 409 `agentcard_company_funding_in_progress` ("funding outcome is not
confirmed") while Org MCP create_card was actually failing with
`card_creation_failed`. The browser workflow silently retried for ~10 minutes
with no progress message, the harness tree-stalled at 510s, and the tool finally
reported "Payment funding is delayed". Compensation later logged the raw
`create_card failed: card_creation_failed`.

## Diagnosis

Critical path:
`create_card MCP error → providerErrorFromUnknown (untyped) → mint charge →
classifyFundingResumeFailure(providerCallStarted=true) → ambiguous rewrite →
mint_payment_card() silent 10m loop → stall / delayed message`.

**Why mint could not succeed for this purchase:** AgentCard stores create_card
outcomes under the idempotency key `purchase:{purchaseId}`. Live replay of
`purchase:b3e6de0e-efe4-4a91-a772-b268f2f44aea` still returns
`status=error` / `create_card failed: card_creation_failed`. A fresh
idempotency key on the same verified cardholder (`cmrs…y7jg`) and live org
wallet (~$159 available) creates a card successfully. So this purchase row is
permanently poisoned at the provider — retries of the same key can never mint.
The original first-attempt AgentCard failure reason is opaque (provider-side);
our bug was classifying that terminal idempotency outcome as ambiguous funding.

Archive search (`card_creation_failed`, `tree stalled … funding delayed`,
`cardholder_not_found fail-closed funding rewrite`): relative of the
cardholder-not-found fail-closed pattern, not a recurrence of a prior case file.
Operational note: Render `BENCHMARK_AGENTCARD_CARDHOLDER_ID` (`cmru…3foy`) is
KYC `pending` and cannot mint; the Integration fixture correctly still points at
the verified `cmrs…y7jg` cardholder — do not re-seed live from the pending env id.

Local repro (pre-fix exit 1 / post-fix exit 0):

```bash
cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
  npx tsx scripts/rca-card-creation-failed-repro.ts
```

## Solution

1. Type `card_creation_failed` in Org MCP (`throwIfCardCreationFailed`) as
   `agentcard_card_creation_failed`.
2. Add that code to `hasSafeProviderFailureCode` so post-provider-call failures
   fail closed instead of rewriting to funding-in-progress.
3. Abandoned-funding compensation treats poisoned mint codes as terminal:
   discard wallet marker, reverse Stripe hold, mark purchase FAILED.
4. Cemented in `purchases.part6.blackbox.ts`, org-MCP unit test, purchase-cleanup
   unit test, and the owning-boundary repro script.

## Human feedback

Approved fail-closed typing; also required diagnosing why mint failed in the
first place (poisoned AgentCard idempotency key), not only the rewrite symptom.

## Reusable lesson

Never rewrite an AgentCard terminal create_card idempotency failure into funding-in-progress — type it, fail closed, and stop replaying the poisoned purchase key.
