---
id: 2026-09-02-browser-biometrics-unknown-action-drag
date: 2026-09-02
title: Browser-use drag advertised but missing from service_actions dispatcher
surface: agents
component: spawn-browser-agent-v3 / service_actions
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/service_actions.py `_INTERACTION_ACTIONS` — omitted `drag` while providers/rose/browser_use.py advertises it"
symptoms:
  - browser-biometrics-webdecoy smoke timeout / PAUSED
  - TOOL errors "Unknown action: drag"
  - agent burns early steps simulating human mouse motion on FCaptcha
tags:
  - browser
  - drag
  - smoke
  - biometrics
sources:
  - agent 8fadb018-2e73-4833-af2d-aa3d0dbd9774
  - PR #1197
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_execute_action_drag_dispatches_to_tool_executor
status: fixed
---

## Problem

Pre-deploy smoke `browser-biometrics-webdecoy` timed out (420s) with the agent
PAUSED after max browser steps. Early TOOL stream showed `Unknown action: drag`.

## Diagnosis

`providers/rose/browser_use.py` advertises `drag` and normalize emits
`action: drag`, but v3 `service_actions` never listed `drag` in
`_INTERACTION_ACTIONS`, so `execute_action` returned Unknown action.

## Solution

Register `drag` in `_INTERACTION_ACTIONS` and dispatch to `_execute_drag`.
Cement with a blackbox that fails closed if drag returns Unknown action.

## Human feedback

Smoke burned steps on advertised-but-undispatched drag before falling back to
coordinate clicks; form eventually submitted but run still timed out.

## Reusable lesson

Every tool name in `BROWSER_USE_TOOLS` / normalize output must have a matching
`service_actions` dispatcher entry. Schema-only additions without dispatcher
wiring turn into silent step burns on live smoke.

## Follow-up

The dispatcher fix held. The next `browser-biometrics-webdecoy` timeout
(`c247de84`) is a different boundary: `_execute_drag` still passed a
coordinate tuple into `ActionHistory.record_action`, which indexed it as a
dict. See `2026-09-02-browser-biometrics-drag-record-action-tuple`.

## Recurrence 2026-11-06

The behaviour behind "agent burns early steps simulating human mouse motion"
was never fixed. Only the drag plumbing was. With drag dispatching correctly,
the model kept using it to fake pointer movement, which raised FCaptcha risk.
For move-from-current-position it sent end-only drags that looped until the
timeout. The missing guardrail was a pointer-only move tool. See
`2026-11-06-browser-pointer-move-intent-had-no-tool`.
