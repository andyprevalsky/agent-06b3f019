---
id: 2026-08-26-browser-state-unboundlocalerror-no-cache-refactor
date: 2026-08-26
title: No-cache browser refactor left observe_page_text reading unassigned browser_state
surface: agents
component: spawn-browser-agent-v3-handler
classification: our-bug
problem_class: other
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py:6676 — auth_runtime_state.observe_page_text(browser_state.get("title")) before loop-level browser_state assignment
symptoms:
  - "UnboundLocalError: cannot access local variable 'browser_state' where it is not associated with a value"
  - "Browser automation failed" last_action=initialization action_count=0
  - spawn_browser_agent_activity_v3 status=error at handler.py:6676
tags:
  - browser
  - read-browser-state
  - unboundlocalerror
  - spawn-browser-agent-v3
sources:
  - commit 214d105a9
  - agent 4744624d-737c-47af-b538-8a4b3aa634b1
  - agent 5e2b26c6-d1e0-4b87-be1b-a576575cfd97
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_auth_title_observation_fetches_fresh_state_not_unassigned_browser_state
status: fixed
---

## Problem

Post-sync browser benchmark rerun (before fix commit `214d105a9`) crashed every
browser task at initialization: `spawn_browser_agent_activity_v3` raised
`UnboundLocalError` on the first loop iteration while resolving the page URL
for auth-realm prep. Worker log:

```
Browser automation failed error=cannot access local variable 'browser_state'
where it is not associated with a value last_action=initialization action_count=0
traceback: handler.py:6676 auth_runtime_state.observe_page_text(browser_state.get("title") or "")
```

Examples: `4744624d` (alchemy, failed 155s), `5e2b26c6` (eventim, failed during
first rerun). Amazon/doordash failed in ~64–65s on the same crash.

## Diagnosis

Removing per-step browser_state caching for Rose LLM calls deleted the loop-level
fetch but left `auth_runtime_state.observe_page_text(browser_state.get("title"))`.
Later branches in the same function assign `browser_state` (recovery paths at
~7507 and ~8038), so Python treats `browser_state` as a local variable for the
entire function. The observe call runs before any assignment on the normal path
→ `UnboundLocalError` at browser init, before any tool action.

First-bad boundary: `handler.py:6676` referencing `browser_state` without a prior
assignment on the main loop path.

## Solution

Fetch a dedicated snapshot for auth title observation only (no LLM DOM injection):

```python
observe_page_state = await dom_service.get_browser_state(include_screenshot=False)
auth_runtime_state.observe_page_text(observe_page_state.get("title") or "")
```

Also removed stray invalid kwargs on `_append_browser_turn_messages` from a merge
artifact (`task`, `browser_state`, `include_screenshot`).

Landed in `214d105a9`. Structural blackbox guard:
`test_auth_title_observation_fetches_fresh_state_not_unassigned_browser_state`.

10k-agent behavior: one lightweight `get_browser_state(include_screenshot=False)`
per browser loop iteration for auth ladder observation — bounded per agent step,
not per-user fan-in.

## Human feedback

None recorded.

## Reusable lesson

When removing a loop variable used for LLM context, grep the whole activity for
every other `browser_state` reference — later assignments make Python treat the
name as local and crash earlier reads.
