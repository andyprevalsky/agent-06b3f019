---
id: 2026-11-06-browser-reattach-replaced-proxy-metadata
date: 2026-11-06
title: Browser proxy location is not available yet after same-session resume
surface: front-end
component: browser-proxy-presentation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: useBrowserStatusBarState selected the latest profile-only browser_session_metadata event as a complete snapshot
symptoms:
  - "Browser proxy location is not available yet after same-session resume"
  - "same-session reattach retains known proxy metadata"
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

Browser proxy location is not available yet after same-session resume. User requested RCA of the missing app browser view and unstable proxy location, plus Tilion as the default for fresh sessions.

## Diagnosis

Runtime: this agent's session_init at 02:15:08.907 UTC included Steel proxy_source and SAN FRANCISCO/CA/US proxy_location. At 02:24:04.689, the same provider-session viewer URL reattached with only provider/profile_id/steel_profile_id. The profile-only event was repeated at 02:24:05 and 02:29:54. The app selected the latest object wholesale, erasing previously known location. At 02:33:13 a replacement session emitted full proxy metadata again.

What: known proxy location disappears on reattachment. Where: extractBrowserSessionMetadata. Why: heterogeneous init/reattach metadata is a partial event stream, but the UI treated each event as a full snapshot. Proof: reduced captured metadata events fail with missing proxy_location/proxy_source before the repair and pass unchanged after it. A separate assertion verifies that replacement sessions cannot inherit the predecessor's exit location. Problem: inconsistent partial-event reduction.

This explains loss of the displayed location; no external exit-IP geolocation measurement was captured, so it does not prove a provider placed the IP in the wrong city.

Critical path: backend session selection/binding → worker session events → persisted messages → app browser owner registration and metadata derivation → drawer selection/viewer and proxy chip.

Archive searches: `browser view blank debugUrl steel`, `proxy location fresh session preferred provider`, `No browser session pendingSwitch`, `proxy_source profile-only reattach`, and `preferredBrowserConfig default provider`. Relatives include the October 9 authoritative-session-binding case and October 23 logical-first-init case; their first-bad boundaries differ. No matching case for this exact boundary was found. This is a relative, not a demonstrated recurrence.

## Solution

Fold metadata newest-first within the current provider-session binding, retaining omitted fields on same-session reattachment and stopping at a resource replacement. Viewer token and control-flag changes preserve identity for Steel, Tilion and Kernel; a native session change resets it. No database schema, provider operation or requested geography changes.

Verification commands: `cd front-end && npx vitest run src/tests/blackbox/browser-drawer-session-regression.blackbox.tsx` and `cd back-end && npx tsx src/tests/blackbox/browser-fresh-provider.blackbox.ts`. Frontend: 2 failing assertions and 1 passing boundary assertion before, 3 passing after; later viewer-token/control-flag coverage adds three passing cases. Backend: preference and placeholder assertions each observed failing before their respective fixes and passing afterward. Original logs are retained privately in `.context/rca-browser-4f77/`. The existing frontend Vitest coverage discovery includes *.blackbox.tsx; backend blackbox run.ts discovers *.blackbox.ts automatically. The related five frontend files passed 55 tests, and the backend browser-provider contract suite passed 52 tests against an isolated localhost database; live provider checks were not executed by that invocation.

Delete/unify/guard assessment: preserve the existing single session owner and event stream; unify fresh selection with the deployment default and reduce deltas at their presentation owner. No extra polling, subscriptions, remote sessions or DB queries are introduced. At 10k agents these remain per-visible-task operations over the current binding's messages, with no shared-channel fan-in.

Golden reference: not applicable (no approval-gated hunk). No prompt or terminal/recovery semantics changed. Independent managed RCA investigation/review could not start: three identical attempts returned `delegation_service_unavailable`; no child was created. That platform issue was already reported in recent feedback. Deployment/review remain pending: GitHub credential acquisition hit its API rate limit and the staged deploy planner refused missing independent worker bindings; status stays open, and the original client timing and actual exit-IP placement remain unverified.

## Human feedback

The user explicitly requires Tilion as the default for every fresh browser session while preserving resumed sessions.

## Reusable lesson

Keep fresh-session selection, same-session event reduction and deferred UI registration consistent with the resource identity they actually own.
