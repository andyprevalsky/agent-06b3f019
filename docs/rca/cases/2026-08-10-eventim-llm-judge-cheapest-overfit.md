---
id: 2026-08-10-eventim-llm-judge-cheapest-overfit
date: 2026-08-10
title: Eventim LLM judge still required cheapest-tier DOM dumps after payment boundary passed
surface: harness
component: eventim-1015-payment-boundary-semantics
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/tasks.json eventim-1015-payment-boundary-semantics judge_prompt — removed "cheapest" without forbidding cheapest-tier dump failures
symptoms:
  - 'eventim-1015-payment-boundary-semantics'
  - 'cheapest-tier'
  - 'All declared static checks passed'
  - 'approvals_triggered=1'
tags:
  - browser-agent
  - eventim
  - llm-judge
  - overfit
  - harness
sources:
  - agent db42d4eb-9eb8-40e2-8b2d-a439160cac51
  - commit 3d3a36cd16108ad432f87bc8a27d0d1004b720c5
repro: agents/benchmarks — eventim-1015-payment-boundary-semantics deoverfit criteria
status: fixed
---

## Problem

Local `browser-1015-eventim-request-card` agent
`db42d4eb-9eb8-40e2-8b2d-a439160cac51` passed the runtime static contract
(`approvals_triggered=1`, payment card observed) and failed only
`eventim-1015-payment-boundary-semantics` because the judge demanded
direct browser proof of cheapest-available GA tier selection.

Evidence from
`agents/benchmarks/runs/20260810_072025_browser-1015-eventim-request-card.json`:

- Static evaluator: passed (`All declared static checks passed`)
- Judge reasoning demanded cheapest-tier / live-inventory DOM dumps despite
  criteria already allowing any upcoming purchasable show and a
  `judge_prompt` that said “single general-admission ticket”
- Declared-judge harness injects `Task requirement: {task.prompt}`; the
  agent prompt still says “cheapest”, so the model reintroduced that bar

## Diagnosis

Weak judge deoverfit (`79f212fe7`) removed the word “cheapest” from
`judge_prompt` but did not tell the judge that payment-approval + Eventim
checkout URL + receipt are sufficient grounding, nor that cheapest-tier
comparison dumps are out of scope. Parallel branch
`cursor/eventim-deoverfit-eval-8cf1` already had the stronger wording.

Owning boundary: evaluator overfit (payment-boundary semantics judging
agent-prompt wording instead of the declared payment-boundary contract).

## Solution

Port the deoverfit `criteria` + `judge_prompt` so the semantic judge:
- accepts payment approval + Eventim hosts + receipt as grounding
- explicitly forbids failing for missing cheapest-tier / DOM dumps

## Human feedback

None recorded.

## Reusable lesson

When deoverfitting an Eventim payment-boundary judge, explicitly forbid cheapest-tier DOM-dump failures and accept payment approval + checkout URL + receipt as sufficient grounding.
