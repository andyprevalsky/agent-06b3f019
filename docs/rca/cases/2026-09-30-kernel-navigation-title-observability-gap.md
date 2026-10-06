---
id: 2026-09-30-kernel-navigation-title-observability-gap
date: 2026-09-30
title: Live Kernel navigation failed its title assertion without a captured first-bad response
surface: back-end
component: browser-provider-parity
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: Unresolved between the live Kernel navigation response and its Example Domain title assertion
symptoms:
  - "Kernel CDP navigation failed"
  - "browser-provider failed its live navigation title assertion"
tags:
  - kernel
  - cdp
  - navigation
  - title
  - observability
sources:
  - PR #1299
  - commit f10d13fdb42507028fcab0a1550f06ea474bd37b
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: open
---

## Problem

A full backend coverage invocation failed the live Kernel provider-parity
navigation assertion. The original assertion and timeout remain unchanged.
An isolated invocation subsequently passed in 148.00 seconds, and the full
backend coverage gate passed all 172 domains, 220 unit cases and its existing
thresholds in 387.17 seconds. Those successful observations do not identify
why the original navigation failed.

## Diagnosis

Archive searches were `Kernel CDP navigation failed title Example Domain` and
`browser provider parity navigation title mismatch`. This is a relative of
`2026-09-10-browser-cdp-latency-causal-evidence-gap`; its WebDecoy deadline and
CDP waits are a different observed boundary. The credential injection cause in
`2026-07-22-steel-parity-harness-injected-key-at-wrong-boundary` also has not been
reproduced for this Kernel navigation failure.

The original capture does not establish the failing response status, document
identity and title at the assertion boundary. No unchanged failing local
reproduction and causal fix pair exists. Host load, provider state, redirects
and transport behavior remain unproven explanations.

## Solution

Keep this case open. The unchanged owning live blackbox remains in backend
coverage. A private Playwright observer records status, hostname, elapsed time,
title length/hash and whether the expected title matched during subsequent
verification; it returns the original browser values without altering requests,
assertions or timeouts. Its successful captures cannot recover the missing
first-bad response. Retain the original failed capture and use the observer
on an actual recurrence before selecting a runtime fix.

Private captures stay under `.context/acceptance/`; no response bodies, signed
URLs, credentials or trajectories are checked in. This documentation adds no
per-agent runtime work, including at 10,000 concurrent agents.

## Human feedback

The user required runtime evidence and an unchanged failing/passing reproduction,
and prohibited claiming an original live issue resolved from substitute evidence.

## Reusable lesson

Capture the failing navigation response and document identity before assigning an intermittent title mismatch to a provider or host.
