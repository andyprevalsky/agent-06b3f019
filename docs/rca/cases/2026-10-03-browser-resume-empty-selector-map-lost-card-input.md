---
id: 2026-10-03-browser-resume-empty-selector-map-lost-card-input
date: 2026-10-03
title: A browser activity resumed after AgentCard setup with an empty selector map, so input_text on the still-live card field failed and the model typed a literal secret name
surface: agents
component: browser-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py execute_action resolved the model's index only against DOMService.selector_map, which a resumed activity's fresh DOMService leaves empty until read_browser_state runs
symptoms:
  - "Action input_text failed: Element with index 6 not found"
  - "card number is required"
  - "agent-payment-setup-resume: FAIL"
  - "Timeout after 497s (dynamic cap=495s) | Agent status: PAUSED (expected COMPLETED)"
tags:
  - browser-agent
  - resume
  - agentcard
  - payment
  - selector-map
sources:
  - PR #1401
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

The deploy Step 6 local smoke failed `agent-payment-setup-resume` (agent `6de7eeaf-821a-4932-a21a-457a4a1ebc97`, run dir `.context/benchmarks/1790988958-1010694-71462`) with `Timeout after 497s (dynamic cap=495s) | Agent status: PAUSED`. The same task on the same HEAD passed in 136s in the Step 6a AgentCard lane minutes earlier (agent `b39737f1-c49e-4d20-99d8-f7ae6a3e9b91`).

## Diagnosis

AgentCard setup completed normally. At 01:00:34.5Z the card (ending 4190) was issued and the browser activity resumed onto the reattached session. At 01:00:45.012Z its first action, `input_text(index=6, "card_number")`, failed with `Element with index 6 not found`. The next state read at 01:00:46Z showed the same `[6]<input id=card-number>`, so the node never went away. A resumed activity builds a fresh `DOMService` whose `_selector_map` stays empty until the model calls `read_browser_state`, and `execute_action` resolved indices only against that map. Model-visible indices are backend node IDs (`browser_use` `_allocate_selector_index`), so index 6 still named the same live node; there was just no snapshot to resolve it against.

From 01:00:48Z the browser model blamed shadow DOM and switched to raw JS. That path skips secret-ref substitution, so it typed the literal text `card_number`. The checkout returned 400 `card number is required` in a loop until the cap, and the runner paused the agent. Diagnostics showed 491s inside one browser tool call, no provider errors, and an 89% tree-wide cache hit (the reported 0% covers only the root call). The 6a run passed only because its model happened to read page state first after resuming, which filled the map.

Local repro: `test_execute_action_resolves_pre_resume_index_on_reattached_session` runs `input_text` on a resumed `DOMService` with an empty map. On the old code it returns `{'success': False, 'error': 'Element with index 6 not found'}`, the exact production error; with the fix it passes. Archive searches for the symptom strings found only evaluator cases about recovered stale-index misses (2026-08-21) and no case about an empty map after resume.

## Solution

- `DOMService.ensure_selector_map()` builds the map from one page-state capture (no screenshot) when this connection has never built one.
- `execute_action` calls it only when the map is completely empty, before reporting an index as not found. An index missing from a populated map, or from the fresh snapshot, still returns the same error.
- Three registered tests in the `spawn_browser_agent_v3` agents blackbox domain (which runs in deploy coverage) cover the resumed-session resolve, the populated-map miss, and the fresh-snapshot miss.
- Cost at 10,000 agents: at most one extra page-state capture per resumed browser activity, only on its first indexed action, bounded by the existing action timeout. No shared state.

## Human feedback

None recorded.

## Reusable lesson

Any per-activity cache that resolves model-visible references must rebuild itself on first use after a resume; an empty cache is not evidence that the referenced object is gone.
