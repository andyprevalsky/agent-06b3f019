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
status: open
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

Archive search (`card_creation_failed`, `tree stalled … funding delayed`,
`cardholder_not_found fail-closed funding rewrite`): no exact prior case for
`card_creation_failed`. Relative of the cardholder-not-found fail-closed pattern
already cemented in `purchases.part6.blackbox.ts` / `throwIfCardholderNotFound`
— deterministic provider rejections must keep a typed safe code so
`hasSafeProviderFailureCode` does not treat them as ambiguous funding.

Local repro on buggy main tip (force local Postgres via `DATABASE_URL` and
`DIRECT_URL` — both must be localhost; injected cloud `DIRECT_URL` otherwise
points Prisma at prod):

```bash
cd back-end && DATABASE_URL="$LOCAL_DB_URL" DIRECT_URL="$LOCAL_DB_URL" \
  npx tsx scripts/rca-card-creation-failed-repro.ts
# LOCAL_DB_URL=postgresql://postgres:***@localhost:5432/victoria
```

Observed: `IS_FUNDING_REWRITE=true`, `errorCode=agentcard_company_funding_in_progress`,
`purchaseStatus=FUNDING_PENDING`, exit 1.

## Solution

Pending approval. Proposed generalizable fix (same class as cardholder_not_found):

1. Type `card_creation_failed` in Org MCP `providerErrorFromUnknown` as
   `agentcard_card_creation_failed` (deterministic pre-commit rejection).
2. Add that code to `hasSafeProviderFailureCode` so post-provider-call failures
   fail closed instead of rewriting to funding-in-progress.
3. Cement in `purchases.part6.blackbox.ts` + org-MCP unit test; keep the
   owning-boundary repro green without raising `AGENT_STALL_SECONDS`.

## Human feedback

None recorded.

## Reusable lesson

Never rewrite an untyped deterministic provider rejection into funding-in-progress after the provider call has started — type it and fail closed.
