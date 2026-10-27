---
id: 2026-10-26-resume-custody-incompatible-fixture-fixed-hold-raced-fork-boot
date: 2026-10-26
title: Resume-custody "incompatible" fixture held the provider create for a fixed 1s, racing the second child's boot under coverage load
surface: back-end
component: browser-session-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/tests/blackbox/browser-session-resume-custody.cases.ts fake provider answered the first create after a fixed 1000ms instead of after the competing resume attempted
symptoms:
  - "assert(!results[1]!.ok)"
  - at runBrowserResumeCustodyCases (browser-session-resume-custody.cases.ts:302:11)
  - FAIL  browser-session under npm run test:coverage, PASS when run alone
tags:
  - browser-session
  - flaky-test
  - resume-custody
  - coverage
sources:
  - task User Scale Bug Bash lane S12 deploy (backend coverage 227/228, run 20261026-222445-119871)
repro: back-end/src/tests/blackbox/browser-session-resume-custody.cases.ts
status: fixed
---

## Problem

The backend coverage run (`npm run test:coverage`, 4 concurrent domains, V8
instrumentation) failed `browser-session` with `assert(!results[1]!.ok)` at
`browser-session-resume-custody.cases.ts:302`. The same domain passed alone
(44s) and also passed under 12 busy-loop CPU hogs.

## Diagnosis

The `incompatible` scenario starts a fresh resume, waits until the fake provider
has counted its create, then forks a second, non-fresh resume. It expects that
second resume to be rejected because custody is still in progress. The fake
provider answered the first create after a fixed 1000ms. The second child must
fork, load tsx and Prisma (coverage-instrumented when the parent is) and reach
its custody check within that window. When it takes longer, the first lifecycle
completes and the second resume legitimately succeeds.

Deterministic repro: insert a 1.5s wait before the second `run()`, simulating a
slow boot. It failed with the identical `assert(!results[1]!.ok)`. With the
fix, the same delayed variant passed. After removing the delay, the domain
passed in five consecutive runs.

This is related to `2026-10-23-resume-custody-held-after-rejected-provider-create`,
which owns the same fixture. It is not a recurrence of that product bug.

## Solution

In the `incompatible` scenario the fake provider now holds the first create
until the second resume settles. A non-ref'd 8s cap keeps a regression failing
rather than hanging, so the race is eliminated by ordering, not by time. No
assertion, scenario or product code changed. 10k-agent behaviour: test-only,
no runtime effect.

## Human feedback

None recorded.

## Reusable lesson

Order concurrent fixture events with an explicit signal from the competing actor, never with a fixed delay that a slow child-process boot can outlast.
