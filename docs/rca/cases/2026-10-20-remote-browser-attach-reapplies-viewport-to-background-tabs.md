---
id: 2026-10-20-remote-browser-attach-reapplies-viewport-to-background-tabs
date: 2026-10-20
title: Remote browser reconnect blocked on background-tab viewport setup before BrowserStartEvent expired
surface: agents
component: dom-service-remote-profile
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: BrowserStartEvent drained a TabCreatedEvent stalled in viewport setup; the production target and CDP wire nonresponse were not captured
symptoms:
  - Event handler browser_use.browser.watchdog_base.BrowserSession.on_TabCreatedEvent was interrupted because of a parent timeout
  - BrowserStartEvent timed out after 30.0s and interrupted any processing of 4 child events
  - Setting viewport to 1920x1080
tags:
  - browser-use
  - viewport
  - reconnect
  - parent-timeout
  - cdp
sources:
  - agent 915ab997-c174-4297-80ac-15347120342f
  - commit 3b60bc47fdcd586a3fac2a117f6cd03761e8936b
repro: agents/tests/blackbox/browser_remote_viewport.blackbox.py
status: open
---

## Problem

Browser task `7f7531a8-86e7-5519-8d90-4687dd58d5d1` was trying to book the
Dallas-to-Paris itinerary in Steel session
`bdd7b988-2546-4488-97c9-b5ffba5e080e`. Its screenshot succeeded at
2026-10-20T01:19:50.762Z. Activity drain handed off at 01:20:11.071676Z, then
resumed activity 111 reattached the same browser. At 01:20:43.340120Z the
browser-use BrowserStartEvent expired after 30 seconds, cancelling its
TabCreatedEvent after about 27 seconds. The UI published the child cancellation
as "parent timeout" and associated it with the restored last screenshot action.

## Diagnosis

Path: deployment drain -> resumed activity -> DOMService.connect ->
BrowserSession.start -> initial TabCreated events -> viewport setup -> queued
BrowserConnectedEvent -> BrowserStartEvent deadline -> child cancellation.
Full retained logs and the error event tree explicitly identify BrowserStartEvent
as the parent. Neither the Temporal activity deadline nor the browser supervisor
deadline expired. The resumed activity ran 51765ms including failure cleanup.
The model had not executed a new action in the resumed activity.

The local profile sets is_local=False but inherits host display/headless defaults.
On a displayless worker browser-use profile.py:1259-1300 selects a 1920x1080
emulated viewport. session.py:1200-1216 applies it to initial tabs during attach.
The first viewport operation completed and the second logged its start without
completion. The explicit target path waits for a locally registered CDP session
and then Emulation.setDeviceMetricsOverride. Timer callbacks ran on schedule;
there is no evidence of a Python event-loop deadlock. The exact second target,
CDP request and reason for a missing response were not retained. A stale target,
renderer or provider transport cause remains unresolved.

The owning-boundary test uses real local Chromium/browser-use/bubus and a loopback
CDP proxy. It withholds only a background target's viewport reply while allowing
other requests/replies. With unchanged deadlines and assertions, the baseline
fails BrowserStart after 30.529s; a candidate preserving the provider viewport
connects in 0.755s, issues zero viewport overrides and preserves 1280x800 pages.
This is failure injection at the observed boundary, not replay of a captured
production wire response. It proves the unnecessary override can cause this
startup failure and that the candidate removes that dependency; it does not
identify why the production browser failed to respond or prove booking success.
A frozen-JavaScript-page control alone did not reproduce failure. A broader
CDP blackhole also blocks another watchdog after the viewport candidate; retain
that failure rather than claiming all unresponsive-browser conditions are fixed.

Canonical runner command and original logs are retained in
`.context/rca-915ab997/browser-findings.txt` and
`browser-runner-{red,green}-final.log`. The only green change is selection of an
isolated candidate module; the permanent regression is unchanged. Baseline runner
reports 0 passed/1 failed in 31.3s; candidate reports 1 passed/0 failed in 1.7s.

Archive searches: `TabCreatedEvent parent timeout` and
`browser hangs deadlock navigation event bus`, plus literal TabCreatedEvent.
The 2026-10-17 nested-browser-timeout deadline-owner case is a relative, not an
established recurrence of this viewport boundary. Its solution and human
feedback were read before selecting the candidate.

## Solution

Set headless=False and no_viewport=True on DOMService's remote
BrowserProfile, preserving the existing Steel/Kernel window and viewport rather
than deriving emulation from the worker's display. These flags configure the
client's attachment profile; they do not relaunch the remote browser. No timeout
increase, retry or synthetic model instruction is proposed. Per-agent connection
work shrinks by one metrics command per tab; no new polling or shared state at
10k agents. Production wire nonresponse capture and exact live task outcome
remain open. The reviewed viewport fix is implemented in an isolated deploy worktree; production rollout is pending.

Golden references read: OpenClaw
`openclaw/extensions/browser/src/browser/pw-session-cdp-transport.ts:260` attaches
via connectOverCDP, while
`openclaw/extensions/browser/src/browser/pw-tools-core.state.ts:286` applies
emulation in an explicit page transition. Hermes
`hermes-agent/tools/browser_tool_session.py:758` applies local headless defaults
only without cdp_url. The candidate converges on separating local launch from
remote attachment. Codex's MCP connection manager and Claude Code's vendored
browser MCP instructions have no native viewport/TabCreated handler analogue;
do not imply all four implement the same browser mechanism.

## Human feedback

The user asked why the browser died from a parent timeout. The user authorized implementing and deploying the independently reviewed viewport-only fix through ordinary code-behavior gates. Preserve the original live agent and browser; do not replay booking. Keep the production wire nonresponse and broader CDP failure injection open.

## Reusable lesson

Identify the actual ancestor deadline and the blocked child operation before changing timeouts, and preserve provider-owned browser geometry during attachment.
