---
id: 2026-09-08-take-control-ack-stalls-same-session-handover
date: 2026-09-08
title: Take-control of an ACTIVE browser stayed USER_REQUESTED until a worker action-boundary ack, so the second live session stalled on Loading
surface: cross
component: browser-session-control
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/browser-session/service.control.ts setBrowserControlState — ACTIVE take-control wrote USER_REQUESTED instead of USER on the same session
symptoms:
  - "Browser agent did not hand control over in time"
  - Take control button stuck on Loading...
  - i tried to take control of the second browser, but everything stalled
  - POST /api/browser-session/task/:taskId/control mode=user returns state requested
  - controlState USER_REQUESTED
tags:
  - browser-session
  - take-control
  - handover
  - live-view
  - second-browser
sources:
  - agent 3b2a912a-0248-478a-a4b9-0693a4983d75
repro: back-end/src/tests/unit/browser-session-control.test.ts + back-end/src/tests/blackbox/browser-session-control.blackbox.ts + front-end/src/tests/blackbox/browser-take-control.blackbox.ts
status: fixed
---

## Problem

User tried to take control of the second live browser on agent
`3b2a912a-0248-478a-a4b9-0693a4983d75` (DHL task `9918ff7f`, Steel session
`7f035626`) while the first browser (`697ccaf8`) was in multi-minute challenge
recovery. The Take control chip stayed on Loading... instead of flipping the
existing live-view URL to interactive.

Runtime evidence: two concurrent spawn_browser_agent tasks; second-browser
actions at the stall window were `switch_tab` / supervisor recovery / evaluate
(15:57–15:59Z). Control API for that task later still showed the original Steel
`debugUrl` (`interactive=false`). No resume/replacement was required — the
session was already live.

Local repro (pre-fix):
`BACKEND_UNIT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria
npx tsx back-end/src/tests/unit/browser-session-control.test.ts`
failed with
`ACTIVE take-control must grant user immediately, got {"state":"requested",...}`.

## Diagnosis

Critical path: Take control click → `takeBrowserControl` POST
`/api/browser-session/task/:taskId/control` `{mode:user}` →
`setBrowserControlState` → FE poll until `state=user` → iframe
`interactive=true`.

At the midpoint (POST response) the data was already wrong: an ACTIVE agent
got `USER_REQUESTED` so the frontend polled 480×250ms (120s) and showed
Loading..., while the worker only acknowledged at an action boundary
(`_wait_for_browser_user_control` in the browser loop). Mid-action
(`switch_tab`, evaluate, challenge recovery) meant no ack → timeout →
rollback.

Why 2: the handshake existed to prevent the agent from racing the user. That
coupled UI enablement to a worker boundary that can be minutes away.
Why 3: the product contract is instant same-session handover (no
resume/reinjection). Immediate USER on the existing `debugUrl`/`sessionId`
satisfies that; the worker already yields on `user`.

Archive searches (`take control second browser handover stall`,
`browser take-control live view session handover stalled`,
`takeControl takeover liveViewUrl same session reinjection`): relatives
(live-view URL selection, second-browser spawn after schema, stale resume
session) — not this handshake. Novel.

## Solution

Grant USER immediately on the same ACTIVE session. Leftover
`USER_REQUESTED` also becomes USER on take-control so a mid-action lease
cannot expire back to AGENT. Keep `acknowledge` as a compat transition.
Delete the 120s FE poll — `requested` or `user` after one POST enables the
existing debug URL. Worker still yields until hand-back.

Siblings prevented: any take-control during a long action; e2e no longer needs
a fake worker-ack loop; FE no longer storms `/control` 4 times/sec for 120s.

10k-agent behavior: one indexed `updateMany` per take-control (keyed by
`BrowserSession.id`). No per-user fan-in, no 480-GET poll storm.

Same unit command now prints `PASS browser-session-control unit (6 cases)`.
HTTP blackbox `browser-session-control` PASS (387ms). FE
`browser-take-control` handover is 4ms / one POST.

Follow-on (CodeRabbit 3961302106): user grants also CAS on
`status=ACTIVE`. A close between the service-layer ACTIVE check and
`updateMany` can no longer flip a dead session to USER. Leftover
`USER_REQUESTED` on CLOSED stays requested.

## Human feedback

User insisted the handover be very fast and reuse the exact same browser
session so no reinjection is required. Do not invent a new session or resume
path to unstick take-control.

## Reusable lesson

Never gate live-view take-control on a worker action-boundary acknowledgement — grant USER on the same session immediately and let the activity yield when it next observes ownership.
