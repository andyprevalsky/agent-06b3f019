---
id: 2026-10-24-browser-use-dump-recorded-default-effort-not-route-wire-effort
date: 2026-10-24
title: Browser-use LLM dump recorded the default xhigh effort and requested temperature instead of what the serving route sent
surface: agents
component: rose-client browser-use dump config (providers/rose/client.py _browser_use_dump_config)
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/providers/rose/client.py _browser_use_dump_config — hardcoded DEFAULT_REASONING_EFFORT and the caller temperature for every non-direct route, ignoring pool-pinned waterfall/Cerebras effort and the Responses body's missing temperature
symptoms:
  - "\"effective_params\": {\"model\": \"gpt-5.6-luna\", \"temperature\": 0.3, \"max_tokens\": 2048, \"reasoning_effort\": \"xhigh\""
  - "Foundry body \"reasoning\": {\"effort\": \"low\"} while the dump says reasoning_effort xhigh"
  - rose-1-browser-use dump effort does not match pools.py waterfall_reasoning_effort
tags:
  - llm-dump
  - observability
  - reasoning-effort
  - browser-use
  - foundry
sources:
  - fleet run descend-full69-20261023 cluster R13 (side finding from R12)
repro: agents/tests/blackbox/rose.blackbox.py::test_browser_use_dump_records_foundry_wire_effort_and_temperature
status: fixed
---

## Problem

While running R12's A/B tests, the local dump for a rose-1-browser-use call
served by Foundry gpt-5.6-luna recorded
`effective_params.reasoning_effort: "xhigh"` and `temperature: 0.3`. The
captured Foundry request body carried `reasoning.effort: "low"` and no
temperature. Someone reading the dump would wrongly believe luna reasoned at
xhigh.

## Diagnosis

The wire is correct. pools.py sets `waterfall_reasoning_effort="low"` on
rose-1-browser-use, and its docstring says the OpenRouter waterfall and the
Foundry fallback stamp that effort (client.py passes
`effort=pool_spec.waterfall_reasoning_effort or effort` to foundry_complete;
waterfall.py uses the same rule). Cerebras stamps
`cerebras_reasoning_effort`. The Responses body
(`build_codex_responses_body`) never sets temperature.

`_browser_use_dump_config` instead hardcoded `DEFAULT_REASONING_EFFORT` and
the caller's temperature for every non-direct route. An existing assertion
(rose.blackbox `test_waterfall_body_builders_always_stamp_effort_xhigh_by_default`)
cemented xhigh for the browser pool's waterfall dump.

Repro: a mocked Foundry `complete_browser_use` captured wire `low`/no
temperature against dump `xhigh`/0.3. It failed before the fix and passes
after.

## Solution

The dump now derives effort and temperature from the route that served the
call (`response.pool_name`):
- Cerebras: `cerebras_reasoning_effort`.
- Foundry: normalized `waterfall_reasoning_effort` (None for no-reasoning
  models) and temperature None.
- OpenRouter waterfall: `waterfall_reasoning_effort or default`.
- Direct auth: unchanged.

I corrected the stale assertion to the wire value. A live check showed the
Foundry body and the dump both read `low`/null. This is observability only;
nothing sent to providers changes. At 10k agents there is no new cost.

## Human feedback

None recorded.

## Reusable lesson

Derive dump "effective" parameters from the same pool fields the serving route's body builder uses (keyed by the response's route), and test the dump against a captured wire body rather than against a constant.
