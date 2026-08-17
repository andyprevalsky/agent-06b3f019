# Eventim min_tool_counts used spawn_agent after browser remap

## Summary

Local `browser-1015-eventim-request-card` reached a grounded `request_payment_card`
(`approvals_triggered=1`, `approvals_resolved=0`) and still failed with:

`Tool 'spawn_agent': expected at least 1 call(s), got 0. Full counts: {..., 'spawn_browser_agent': 1, 'request_payment_card': 1}`

## Evidence

- Agent: `8953d667-f384-4e14-b6b4-0a55cae5e8e4`
- Run: `agents/benchmarks/runs/20260810_060911_browser-1015-eventim-request-card.json`
- Root ASSISTANT requested `spawn_agent` (browser); TOOL rows recorded
  `spawn_browser_agent`
- `_count_logical_tool_calls_from_messages` remaps
  `spawn_agent` + `type=browser` → `spawn_browser_agent` (see
  `test_logical_tool_counts_canonicalize_model_facing_routed_calls`)

## Root cause

Task had `min_tool_counts: { "spawn_agent": 1 }` after the exact-count→min
relaxation (`419949059`). Browser ecommerce peers use the remapped key
`spawn_browser_agent`. The Eventim key could never pass a correct browser path.

## Fix

Set Eventim `min_tool_counts` to `{ "spawn_browser_agent": 1 }` and cement that
in `test_eventim_1015_request_card_benchmark_contract`.

## Classification

Harness/task-contract mismatch (wrong tool key vs logical count canonicalization).
Not an antibot/payment-boundary product failure.
