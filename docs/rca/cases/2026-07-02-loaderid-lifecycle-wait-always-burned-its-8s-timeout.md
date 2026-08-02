---
id: 2026-07-02-loaderid-lifecycle-wait-always-burned-its-8s-timeout
date: 2026-07-02
title: browser-use's loaderId lifecycle wait never resolved, so every navigation burned its full 8s timeout
surface: agents
component: browser-agent
classification: third-party-failure
problem_class: timeout-too-aggressive
first_bad_boundary: vendored browser-use navigation readiness — loaderId lifecycle wait never matched, falling through to the 8s timeout
symptoms:
  - "[TIMING] Browser agent setup timeline shows a constant ~8s navigation-readiness segment"
  - browser spin-up 44.6s in-activity baseline
  - navigation readiness wait always hits its timeout instead of resolving
tags:
  - browser-agent
  - browser-use
  - cdp
  - latency
  - navigation
sources:
  - memory:project_browser_spinup_optimization
repro: agents/benchmarks — browser-smoke benchmark (watch worker log for "[TIMING] Browser agent setup timeline")
status: fixed
---

## Problem

Browser-agent spin-up measured 44.6s in-activity. Instrumenting it with the
`[TIMING] Browser agent setup timeline` log on the `browser-smoke` benchmark
showed a fixed ~8s block attributable to navigation readiness: browser-use's
`loaderId` lifecycle wait **always** burned its full 8s timeout rather than
resolving early.

## Diagnosis

The vendored browser-use navigation path waits for a CDP page-lifecycle event
matched against the navigation's `loaderId`. In our session setup that match
never occurred, so the wait had exactly one exit: the timeout. Because the
timeout is the only exit, the cost was constant on every navigation and
invisible as an "error" — it looked like slow page loading rather than a
readiness predicate that never fires. This is one of several places where the
vendored connect path costs fixed round-trips (the record also notes a 9-RTT
connect chain and a `PopupsWatchdog` wasted `Page.enable` RTT, both upstream).

## Solution

Replaced the lifecycle wait with a `readyState` navigation-readiness poll, which
resolves as soon as the document is actually ready. Shipped on branch
`andyprevalsky/browser-startup-latency` alongside the other spin-up wins
(validation-CDP-connection reuse for `injectUserData`, rejected-proxy-city
cache, `auth_options` prefetch, parallel dom/playwright connects, CDP recorder
screenshots, overlapping humanizer/recorder/logo with navigation), taking
spin-up from 44.6s to 16.6s warm-best and ~22-29s under slow Steel patches.

## Human feedback

None recorded.

## Reusable lesson

A wait that costs exactly its timeout on every call is not a slow dependency —
it is a readiness predicate that never fires; replace the predicate rather than
shortening the timeout.
