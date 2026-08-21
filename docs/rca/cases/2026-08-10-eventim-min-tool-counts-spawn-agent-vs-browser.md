---
id: 2026-08-10-eventim-min-tool-counts-spawn-agent-vs-browser
date: 2026-08-10
title: Eventim min_tool_counts used spawn_agent after browser remap to spawn_browser_agent
surface: harness
component: eventim-1015-request-card-benchmark-contract
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/tasks.json browser-1015-eventim-request-card min_tool_counts.spawn_agent — wrong key after logical remapping
symptoms:
  - "Tool 'spawn_agent': expected at least 1 call(s), got 0"
  - "'spawn_browser_agent': 1"
  - "'request_payment_card': 1"
  - approvals_triggered=1
tags:
  - browser-agent
  - eventim
  - min-tool-counts
  - spawn-browser-agent
  - harness
sources:
  - agent 8953d667-f384-4e14-b6b4-0a55cae5e8e4
  - commit 87faedab1788a7ec4b70514fec00be7ee3ec150e
repro: agents/benchmarks — test_eventim_1015_request_card_benchmark_contract
status: fixed
---

## Problem

Local `browser-1015-eventim-request-card` reached a grounded `request_payment_card`
(`approvals_triggered=1`, `approvals_resolved=0`) and still failed with:

`Tool 'spawn_agent': expected at least 1 call(s), got 0. Full counts: {..., 'spawn_browser_agent': 1, 'request_payment_card': 1}`

Evidence:

- Agent: `8953d667-f384-4e14-b6b4-0a55cae5e8e4`
- Run: `agents/benchmarks/runs/20260810_060911_browser-1015-eventim-request-card.json`
- Root ASSISTANT requested `spawn_agent` (browser); TOOL rows recorded
  `spawn_browser_agent`
- `_count_logical_tool_calls_from_messages` remaps
  `spawn_agent` + `type=browser` → `spawn_browser_agent` (see
  `test_logical_tool_counts_canonicalize_model_facing_routed_calls`)

## Diagnosis

Task had `min_tool_counts: { "spawn_agent": 1 }` after the exact-count→min
relaxation (`419949059`). Browser ecommerce peers use the remapped key
`spawn_browser_agent`. The Eventim key could never pass a correct browser path.

Owning boundary: harness/task-contract mismatch (wrong tool key vs logical
count canonicalization). Not an antibot/payment-boundary product failure.

## Solution

Set Eventim `min_tool_counts` to `{ "spawn_browser_agent": 1 }` and cement that
in `test_eventim_1015_request_card_benchmark_contract`.

## Human feedback

None recorded.

## Reusable lesson

After logical tool-count remapping, Eventim (and peer browser ecommerce) `min_tool_counts` must use `spawn_browser_agent`, not the model-facing `spawn_agent` key.
