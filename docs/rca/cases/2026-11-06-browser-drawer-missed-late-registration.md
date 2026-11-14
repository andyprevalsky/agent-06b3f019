---
id: 2026-11-06-browser-drawer-missed-late-registration
date: 2026-11-06
title: Browser drawer stays on No browser session although its agent browser tab exists
surface: front-end
component: browser-drawer-selection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RoseAppsProvider skipped the first selected-agent effect and toggleApp did not retain a pending selection when the browser registered after opening
symptoms:
  - "Browser drawer stays on No browser session although its agent browser tab exists"
  - "No browser session"
tags:
  - browser
  - live-view
  - proxy
sources:
  - agent 4f77a454-7ee9-449d-9803-175056487f9e
  - commit d16c934b7e19446d7069c7f76d8dd550b2058a96
repro: front-end/src/tests/blackbox/browser-drawer-session-regression.blackbox.tsx
status: open
---

## Problem

Browser drawer stays on No browser session although its agent browser tab exists. User requested RCA of the missing app browser view and unstable proxy location, plus Tilion as the default for fresh sessions.

## Diagnosis

Runtime: agent 4f77a454-7ee9-449d-9803-175056487f9e has an ACTIVE Steel browser task 8d3b7e9c-9002-507b-92b2-f962280eab9b. Render live-view reads returned HTTP 200 between 02:29:50 and 02:36:01 UTC on November 6. Its stored viewer URL streamed successfully in a read-only browser inspection (HTTP 200, two canvases, no page errors). The original app's DOM and selection state were not captured, so attribution of that particular blank view remains an observability gap.

What: a selected agent's Browser drawer can remain in the empty state after its task becomes available. Where: RoseAppsProvider pendingSwitchRef initialization and toggleApp. Why: registration only completes a pending switch; initial selection skips its effect, and opening before task registration leaves no pending switch. Proof: the permanent test opens the drawer before mounting the browser owner, then asserts that late registration displays the iframe; before the fix it fails with `expected <div ...> to be null` at browser-no-session. Problem: incomplete async selection/registration contract.

The same test passes unchanged after retaining the pending selected-agent intent and cancelling it on explicit tab selection. This proves the mechanism, not the unrecorded original client timing.

Critical path: backend session selection/binding → worker session events → persisted messages → app browser owner registration and metadata derivation → drawer selection/viewer and proxy chip.

Archive searches: `browser view blank debugUrl steel`, `proxy location fresh session preferred provider`, `No browser session pendingSwitch`, `proxy_source profile-only reattach`, and `preferredBrowserConfig default provider`. Relatives include the October 9 authoritative-session-binding case and October 23 logical-first-init case; their first-bad boundaries differ. No matching case for this exact boundary was found. This is a relative, not a demonstrated recurrence.

## Solution

Initialize the pending selection from selectedAgentId and retain that intent when opening before registration. Explicit Root/tab choices cancel it. This fixes the registration race without polling, browser allocations or a second session owner.

Verification commands: `cd front-end && npx vitest run src/tests/blackbox/browser-drawer-session-regression.blackbox.tsx` and `cd back-end && npx tsx src/tests/blackbox/browser-fresh-provider.blackbox.ts`. Frontend: 2 failing assertions and 1 passing boundary assertion before, 3 passing after; later viewer-token/control-flag coverage adds three passing cases. Backend: preference and placeholder assertions each observed failing before their respective fixes and passing afterward. Original logs are retained privately in `.context/rca-browser-4f77/`. The existing frontend Vitest coverage discovery includes *.blackbox.tsx; backend blackbox run.ts discovers *.blackbox.ts automatically. The related five frontend files passed 55 tests, and the backend browser-provider contract suite passed 52 tests against an isolated localhost database; live provider checks were not executed by that invocation.

Delete/unify/guard assessment: preserve the existing single session owner and event stream; unify fresh selection with the deployment default and reduce deltas at their presentation owner. No extra polling, subscriptions, remote sessions or DB queries are introduced. At 10k agents these remain per-visible-task operations over the current binding's messages, with no shared-channel fan-in.

Golden reference: not applicable (no approval-gated hunk). No prompt or terminal/recovery semantics changed. Independent managed RCA investigation/review could not start: three identical attempts returned `delegation_service_unavailable`; no child was created. That platform issue was already reported in recent feedback. Deployment/review remain pending: GitHub credential acquisition hit its API rate limit and the staged deploy planner refused missing independent worker bindings; status stays open, and the original client timing and actual exit-IP placement remain unverified.

## Human feedback

The user explicitly requires Tilion as the default for every fresh browser session while preserving resumed sessions.

## Reusable lesson

Keep fresh-session selection, same-session event reduction and deferred UI registration consistent with the resource identity they actually own.
