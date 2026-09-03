---
id: 2026-09-02-browser-biometrics-drag-record-action-tuple
date: 2026-09-02
title: Successful CDP drag crashes in record_action on tuple coordinates
surface: agents
component: spawn-browser-agent-v3 / ActionHistory.record_action
classification: our-bug
problem_class: caller-callee-coordinate-shape-mismatch
first_bad_boundary: "agents/browser_tools/dom_service.py ActionHistory.record_action — indexes coordinates['x'] while _execute_drag/_execute_click_coordinates pass (x, y)"
symptoms:
  - browser-biometrics-webdecoy smoke timeout / PAUSED
  - TypeError: tuple indices must be integers or slices, not str
  - drag CDP succeeds then TOOL step fails
  - agent never calls done
tags:
  - browser
  - drag
  - smoke
  - biometrics
  - record_action
sources:
  - agent c247de84-7aeb-4405-b68a-53bfe3f41506
  - PR #1209
  - relative of 2026-09-02-browser-biometrics-unknown-action-drag
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_execute_drag_records_through_real_action_history
status: fixed
---

## Problem

Pre-deploy smoke `browser-biometrics-webdecoy` timed out at 424s / cap 420s
with agent `c247de84` PAUSED. Drag was dispatched (the prior unknown-action
fix held) and CDP mouse events succeeded, then `record_action` crashed four
times with `TypeError: tuple indices must be integers or slices, not str`.
The agent looped without `done`; the harness paused at the cap.

## Diagnosis

Archive search: `tuple indices must be integers or slices, not str record_action drag`
and `browser-biometrics-webdecoy drag`. Closest hit is
`2026-09-02-browser-biometrics-unknown-action-drag` (dispatcher 404). That
`first_bad_boundary` is not this one — drag now reaches `_execute_drag`.

`_execute_drag` records `coordinates=(start_x, start_y)`. `record_action`
did `coordinates["x"]`. The same latent contract exists on
`_execute_click_coordinates`. The previous cement mocked `_execute_drag`, so
the sink never ran.

Local repro (old sink): `TypeError` on `record_action(coordinates=(100, 200))`;
unmocked `_execute_drag` returned `success: False` after the same TypeError.

## Solution

`normalize_action_coordinates` accepts `{"x","y"}` or `(x, y)` / `[x, y]`.
Cement with an unmocked `_execute_drag` + real `ActionHistory`, and a direct
tuple `record_action` test. Do not raise the 420s smoke cap.

## Reusable lesson

A dispatcher-only blackbox that mocks the implementation cannot catch a
post-success recording crash. If the production caller passes a tuple, the
cement must call the real sink with that tuple.
