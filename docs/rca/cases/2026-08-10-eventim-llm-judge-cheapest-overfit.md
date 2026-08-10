# Eventim LLM judge still required cheapest-tier DOM dumps

## Summary

Local `browser-1015-eventim-request-card` agent
`db42d4eb-9eb8-40e2-8b2d-a439160cac51` passed the runtime static contract
(`approvals_triggered=1`, payment card observed) and failed only
`eventim-1015-payment-boundary-semantics` because the judge demanded
direct browser proof of cheapest-available GA tier selection.

## Evidence

- Run: `agents/benchmarks/runs/20260810_072025_browser-1015-eventim-request-card.json`
- Static evaluator: passed (`All declared static checks passed`)
- Judge reasoning demanded cheapest-tier / live-inventory DOM dumps despite
  criteria already allowing any upcoming purchasable show and a
  `judge_prompt` that said “single general-admission ticket”
- Declared-judge harness injects `Task requirement: {task.prompt}`; the
  agent prompt still says “cheapest”, so the model reintroduced that bar

## Root cause

Weak judge deoverfit (`79f212fe7`) removed the word “cheapest” from
`judge_prompt` but did not tell the judge that payment-approval + Eventim
checkout URL + receipt are sufficient grounding, nor that cheapest-tier
comparison dumps are out of scope. Parallel branch
`cursor/eventim-deoverfit-eval-8cf1` already had the stronger wording.

## Fix

Port the deoverfit `criteria` + `judge_prompt` so the semantic judge:
- accepts payment approval + Eventim hosts + receipt as grounding
- explicitly forbids failing for missing cheapest-tier / DOM dumps

## Classification

Evaluator overfit (payment-boundary semantics judging agent-prompt wording
instead of the declared payment-boundary contract).
