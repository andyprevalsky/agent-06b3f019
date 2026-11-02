---
id: 2026-10-28-kernel-parity-eviction-read-returned-untraced-404
date: 2026-10-28
title: Live provider parity lost the response evidence for a superseded Kernel session lookup
surface: back-end
component: browser-provider-live-parity
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: the post-switch lookup of the exact superseded Kernel session returned SDK 404 without retained raw response or stack
symptoms:
  - "FAIL live Kernel provider parity: 404 Session not found"
  - "backend blackbox 233 passed, 1 failed; unit exit 0"
tags:
  - kernel
  - steel
  - provider-switch
  - session-eviction
  - observation-gap
sources:
  - commit 48ccad7bb3e56a889d9294e46f57448991d3145a
  - memory: deploy 20261027-010544-539506 batch11
repro: back-end/src/tests/blackbox/browser-provider.live.support.ts
status: open
---

## Problem

The native backend coverage command exited 1 after 956.3 seconds on the frozen
source above. Its only failing domain was browser-provider; 233 siblings and
the unit suite passed. Live Kernel parity reported an SDK 404 after a successful
Kernel-to-Steel provider switch. The catch printed only the error message.

## Diagnosis

The exact Kernel session was read successfully after stale-proxy resume. The
subsequent rotation returned 200 and tracked the replacement Steel allocation.
The next SDK call in browser-provider-rotation.support.ts inspected the old
Kernel ID with include_deleted=true, before its deleted_at assertion. No next
rotation started. This localizes the observation boundary; it does not prove
hard deletion, provider state loss, incorrect credentials, or a host-load cause.
The original raw outbound response and stack are unavailable.

Literal Session-not-found and behavioral eviction/tombstone archive searches
found related lifecycle incidents but no causal match. The prior shared-proxy
case forbids deleting project-shared geo proxies; it is not adopted as this cause.

## Solution

No product or test fix was made. The unchanged canonical browser-provider domain
passed in 133525 ms on the same source. Private metadata capture observed 200
responses for the superseded-session reads; the original 404 did not recur.
A passing replay is not causal repair. Original failure evidence remains under
.context/test-runs/backend-coverage-failed-20261028-005524-1663219; the replay,
request metadata and exact command are under
.context/deploy-fresh-20261027/kernel-parity-batch11/. Two later native full backend runs passed Kernel parity; each failed a distinct
treasury check. No original 404 causal repair or overall backend PASS is claimed.

The observer records method, path, status, PID and duration only, preserving
fetch arguments/results and all original assertions. An initial private path
mistake failed before native test startup and is retained separately, not used
as the RCA reproduction.

## Human feedback

No new incident-specific feedback. Preserve the original failure and distinguish
successful current validation from an explained historical root cause.

## Reusable lesson

Retain the exact post-release inspection response and stage before accepting a
404 as absence or changing a tombstone assertion; live successful replays cannot
supply missing historical lifecycle evidence.
