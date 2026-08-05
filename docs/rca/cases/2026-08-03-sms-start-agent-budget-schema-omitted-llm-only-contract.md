---
id: 2026-08-03-sms-start-agent-budget-schema-omitted-llm-only-contract
date: 2026-08-03
title: SMS start-agent schema omitted the agent-run-only budget contract
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: start_new_agent.budget_dollars in the runtime response schema carried no description of what the budget pays for
symptoms:
  - SMS movie-ticket request created agent d29e631e-b78a-40dd-8f0b-732d1143a854 with priceLimitCents 12000 and treeCostCents 7
  - start_new_agent runtime response schema gave budget_dollars no description
tags:
  - sms-supervisor
  - start-new-agent
  - price-limit
  - purchase-budget
  - prompt-contract
sources:
  - agent d29e631e-b78a-40dd-8f0b-732d1143a854
  - memory: controlled SMS purchase prompt trials on 2026-08-03
repro: back-end/src/tests/blackbox/sms-supervisor-budget.blackbox.ts
status: open
---

## Problem

The production SMS `3 tickets to the odyssey, seats together, imax, this
night. Buy me now go` created source-SMS agent
`d29e631e-b78a-40dd-8f0b-732d1143a854` with `priceLimitCents=12000` ($120).
The same persisted row recorded only `treeCostCents=7` ($0.07) before failure.
The $120 value was a purchase-scale amount selected while handling the ticket
request, but the agent price limit controls LLM and metered tool/service spend;
checkout transactions use the separate purchase-approval and one-time-card
path.

The exact historical SMS-supervisor LLM request/response was not archived. The
R2 trace for this root agent starts after delegation and therefore cannot replay
the model's original `start_new_agent` arguments. The persisted Agent row is the
unambiguous committed output, while the missing pre-delegation trace is a
secondary observability gap.

## Diagnosis

The critical path is:

1. `supervisorHandler.ts` passes `SUPERVISOR_RESPONSE_MODEL` to the production
   SMS-supervisor LLM call.
2. That model is built from `schema.ts`. Its
   `startNewAgentCallSchema.arguments.budget_dollars` was only
   `z.number().nullable()`, so the emitted JSON schema gave the model no
   description, cost domain, default guidance, or purchase exclusion.
3. `commitStartNewAgent` correctly converts the selected dollar value to cents
   and stores it in `Agent.priceLimitCents`; it does not invent or inflate the
   value.
4. `agents/workflows/agent_workflow.py::_track_usage` adds both LLM costs and
   metered service/tool costs to `own_cost_cents`, and `_check_cost_limit`
   compares the resulting subtree cost with this limit. Browser checkout
   separately requires purchase approval, so purchase price never belongs in
   this field.

The first observed bad boundary is the persisted Agent row. Because
`commitStartNewAgent` is a direct dollars-to-cents conversion, that row proves
the supervisor selected a $120 agent budget. The missing historical supervisor
response means copying the ticket price is an inference from the purchase
context and purchase-scale value, not a captured quote from the model.

The owned causal boundary is the runtime structured-response schema: the model
was asked for an undescribed `budget_dollars` number while handling a purchase
request, and no other SMS-supervisor text defined what the field pays for. The
approved field description closes that wiring gap.

The deterministic schema contract regression reads that boundary directly.
Before the field-description change,
`npx tsx src/tests/blackbox/sms-supervisor-budget.blackbox.ts` failed with
`start_new_agent.budget_dollars runtime description is missing`; it now passes.
The unchanged live-model replay
(`testRealLlm_purchaseRequestSpawnsAgent`) remains the behavioral acceptance
because current routing is nondeterministic.

## Solution

The approved fix is exactly one line of model-facing text: `.describe('Agent-run
budget for LLM and metered tool calls only (default $1; usually under $2). Never
include purchase cost; purchases are approved separately.')` on the runtime
`budget_dollars` Zod field in `schema.ts`. It gives the model awareness of what
the budget means at the only boundary where it selects the number.

No SMS surface-prompt rule, per-scenario example, or numeric server-side cap is
added. Earlier drafts that appended movie-ticket-specific delegation and budget
instructions were rejected as overfitting to a single captured request and were
reverted; the field description is the whole change.

The behavioral acceptance is the unchanged real-LLM purchase test, which must
persist `priceLimitCents < 200` before this RCA can close.

This tells the supervisor handling any SMS purchase task—not just movie
tickets—not to copy the transaction amount into the agent-run limit. It does not
hard-cap the numeric value, change checkout approval, payment authorization,
database shape, API behavior, or non-SMS agent creation. At 10,000 agents it
adds no query, state, or lock work, but it adds static prompt tokens to every
SMS-supervisor model round and can lower initial agent budgets. The normal
budget increase flow remains available if a legitimately complex task exhausts
its initial budget. Keeping the guidance as a field description rather than
scenario examples avoids pinning the supervisor to one captured request shape.

`supervisorTools.schemas.ts` is an inactive exported duplicate: repository
search found no production LLM consumer, and `supervisorHandler.ts` does not use
it. Synchronizing or removing that misleading parallel schema is explicitly out
of this prompt-only approval scope; the regression intentionally targets the
generated runtime response schema instead.

## Human feedback

The human clarified that the start-agent price limit applies to agent-run cost,
not purchases. They described it as the LLM-call budget and required a
movie-ticket reproduction that was above $10 before the fix and below $1
afterward, then explicitly allowed the corrected budget to be under $2. Runtime
inspection additionally established that metered tool/service calls share this
limit, so the proposed wording preserves that owned accounting behavior instead
of falsely labeling it LLM-only. They approved the `budget_dollars` field
description and rejected the follow-on prompt and tool-selection text as
overfitting: the supervisor needs awareness of what the budget means, not
per-scenario instructions.

## Reusable lesson

Define every monetary tool field by the complete cost domain it controls, and
explicitly separate agent-run caps from approval-gated transaction amounts.
