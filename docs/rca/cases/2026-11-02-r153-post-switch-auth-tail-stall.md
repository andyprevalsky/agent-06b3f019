---
id: 2026-11-02-r153-post-switch-auth-tail-stall
date: 2026-11-02
title: Post-switch authentication tail stalls before a captured nested phase
surface: agents
component: browser-action-finalization
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: "Native tab switch is acknowledged, then post-action authentication work does not return before the supervisor cap"
symptoms:
  - Native PAUSED with progress0 and canonical FAILED
  - Successful switch_tab precedes a completed prepare-auth HTTP response
  - Supervisor cap records an outer Playwright wait without the nested operation
tags:
  - r153
  - it38
  - post-action
  - authentication
sources:
  - commit 1dc2af2f263dfaca575e24e7f3f788daace01f5c
  - agent 4284bafe-369f-4034-83c8-830299881b73
  - plan: It38 r001-j0004 fleet20261102-170252-3131777
repro: Original source and sealed chronology establish the post-switch wait; the exact nested await is not captured
status: open
---

## Problem

Original task polar-odysseys-38039bd8d846 executes1dc/patchnone and ends native PAUSED/progress0. Its canonical row is FAILED; the non-completed native attempt remains unscored. The recorded523s tree-stall threshold result is distinct from the operational runtime-stall classification and from the later heartbeat failure.

## Diagnosis

Full custody archive SHA256 is5f39d30f813149fb0cb49faada491bd1db9a65517f5f2767b2dce8baed6d7dff. All112 regular files in147 indexed entries and all7 normal manifest members independently verify. Original run SHA256 isa06c77ac62eab3e171402bb05a114f18d8880253330e4b28b9517de3bafdb3f6; worker33505e7525795c949a12640993bd5123e614ef286013bba19ab875d4fb27e8cf; backendc43263c510842c7e8c72d48973c856dade6303e351a0a4361223096230fd061b.

Worker line24129 records native switch action38;24130 acknowledges tab42AD at17:39:43.519321. The same browser session's prepare-auth request7d7944528d65 starts at backend26092,17:39:45.199, and returns HTTP200 at26125,17:39:47.833. No completed action-result publication follows. At worker25601,17:45:09.196837, the330s supervisor cap records task43551 pending in handler10283 awaiting execute_action, with a Playwright future callback. The first pause occurs only at17:48:29; activity cancellation follows17:48:32.317730. The later17:51:17 heartbeat timeout cannot explain the initial pre-pause stall. Browser network responses continue around the cap; this does not establish a global transport outage.

Exact source records the switch acknowledgement inside _execute_switch_tab before execute_action awaits _attach_observed_auth_context. That tail reads page identity, invokes authentication preparation and validates identity again. The backend response narrows the observed boundary beyond the native switch, but its response body, worker-side apply stage and nested coroutine stack are not captured. Guest diagnostics contain resource samples, not that discriminator. The cap's outer stack cannot select among worker-side state application, a later identity/authentication await, cancellation drain or subsequent diagnostic probe. The independent R154 reproduction proves a probe deadline defect but does not identify which operation this original activity awaited.

## Solution

Original cause remains OPEN. The parent classified the observed unrecovered runtime stall under its operational-stop rule; that does not regrade this PAUSED attempt or prove a provider cause. No timeout increase, arbitrary tab fallback, new browser session or authentication bypass is proposed. Preserve the missing prepare-auth response payload and nested phase as missing evidence; a future capture must identify operation ownership without logging credentials or page content.

Two archive searches covered supervisor-cap/cancellation and switch-tab/identity/timeout. R84's diagnostic attachment budget and prior switch acknowledgement cases are comparators. This original already acknowledged the requested switch, unlike a missing acknowledgement; R154's cancellation mechanism is a separately reproduced defect rather than an attribution shortcut. No original-task replay or repair credit is claimed.

## Human feedback

The user prioritizes native agent failures, progress zero and schema/validator data flow while keeping all failures in scope.

## Reusable lesson

A successful native switch and a successful server response do not prove completion of post-action authentication work. Preserve the nested await and its owner before choosing a repair; do not replace missing causal evidence with a separately reproducible diagnostic defect.
