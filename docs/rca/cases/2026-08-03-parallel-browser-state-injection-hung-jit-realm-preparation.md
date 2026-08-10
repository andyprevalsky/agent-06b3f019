---
id: 2026-08-03-parallel-browser-state-injection-hung-jit-realm-preparation
date: 2026-08-03
title: Parallel BrowserContext state injection hung optional just-in-time realm preparation
surface: cross
component: browser-credential-injection
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/steel/injection.ts::injectUserData launched multiple remote BrowserContext.addInitScript mutations concurrently and placed no deadline around the browser-state phase
symptoms:
  - AMC stopped after "[4/5] Injecting browser state in parallel..." and produced no completion log
  - three same-session credential-preparation attempts stopped at the identical browser-state phase
  - optional realm preparation failure entered generic browser recovery instead of continuing guest checkout
tags:
  - browser-agent
  - credentials
  - browser-state
  - add-init-script
  - guest-checkout
  - concurrency
  - timeout
sources:
  - agent be334a12-f081-4dcf-a2d8-f20c069dc8ad
  - agent 4b636b8a-7198-45b1-ba22-b44531b5fcd2
  - commit ba51fb349
repro: back-end/src/tests/blackbox/steel-injection.blackbox.ts
status: open
---

## Problem

The Epoch 9 AMC benchmark reached a cross-realm credential preparation and then
stopped after `[4/5] Injecting browser state in parallel...`. The original agent
`be334a12-f081-4dcf-a2d8-f20c069dc8ad`, browser session
`ku6regro1vhtgzo3lo960eil`, showed the same incomplete phase at approximately
22:24:52, 22:31:08, and 22:34:20 UTC. The phase never emitted its completion log,
so the browser agent received no next model turn and the benchmark was paused at
22:35:06 UTC.

Archive searches for `Injecting browser state in parallel addInitScript hang`
and `browser credential realm preparation guest checkout stalled` found related
credential-size, provider-environment, and remote-CDP latency cases, but no case
at this first-bad boundary. The earlier provisional diagnosis that the initial
CDP connection hung was falsified by adversarial review: runtime evidence showed
that connection had completed and execution had advanced into browser-state
injection.

## Diagnosis

The critical path was `cross-realm navigation -> POST /prepare-auth ->
prepareJitCookieBundle -> injectUserData -> retained Playwright BrowserContext ->
browser-state addInitScript operations -> browser agent resumes`. Cookies were
injected and the retained context was reached; the first wrong boundary was the
browser-state phase, where localStorage, IndexedDB, permissions, cache storage,
and scrollbar scripts were submitted concurrently through `Promise.all` to one
remote Playwright channel. There was also no deadline around that phase, so one
stalled channel operation could hold the whole preparation indefinitely.

The permanent backend blackbox uses a retained-browser fake whose
`addInitScript` never resolves. Before the fix, the exact fixture exceeded its
500 ms causal budget and launched overlapping calls. With the fix, the same
fixture rejects with an explicit browser-state timeout in about 77 ms and records
`callCount === 1` and `maxActiveCalls === 1`.

## Solution

`injectUserData` now serializes all browser-state mutations on the single
BrowserContext channel and bounds the complete phase with
`BROWSER_STATE_INJECTION_TIMEOUT_MS`, defaulting to 15 seconds. The existing
15-second CDP-connect deadline remains useful secondary hardening, but it is not
the diagnosed root cause.

The agent-side optional-realm boundary now quarantines every preparation failure
stage and continues navigation without saved credentials. Redirected realm
reload happens only after successful preparation. This preserves authenticated
state for account-bound tasks while allowing guest checkout to proceed.

The unchanged causal blackbox is green at 9/9, the browser-credential blackbox is
green at 10/10, the full `spawn-browser-agent-v3` domain suite is green, and the
backend build, Ruff, and Prettier checks pass. The exact unchanged AMC benchmark
rerun is recorded separately before this case is marked fixed.

## Human feedback

Andy clarified that the commerce tasks should use guest checkout outside the
account-bound Uber flow. That correction made saved-state preparation optional
for AMC, Instacart, Booking, and the other guest-capable tasks.

## Reusable lesson

Serialize mutations sent through one remote browser context, bound every optional state-injection phase, and let guest-capable flows continue when saved-state preparation fails.
