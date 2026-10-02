---
id: 2026-09-30-browser-session-forgets-resolved-kernel-proxy
date: 2026-09-30
title: Kernel browser resume forgot the last resolved proxy after rotation
surface: back-end
component: browser-session-kernel
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/kernel.ts persisted the BrowserSession without the resolved proxy source, so recreateKernelSession restarted default proxy selection
symptoms:
  - 'FAIL live Kernel provider parity: resume lost resolved proxy fallback metadata'
  - 'FAIL live Kernel provider parity: resume lost the rotated proxy choice'
  - 'kernel_mobile_city before resume, kernel_residential_city after resume'
tags:
  - kernel
  - browser-session
  - proxy-rotation
  - resume
  - proxy-fallback
sources:
  - commit 06f714328b0a555e35fa55d356c07e1684c1a25e
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: fixed
---

## Problem

The back-end coverage deploy gate failed its live `browser-provider` parity test with
`resume lost resolved proxy fallback metadata`. Task
`4514c3a3-5e3a-4f64-8624-8788992a7c94` rotated first to residential,
then mobile, and paused before `POST /api/browser-session/resume`. Its actual
exit-IP ladder changed from `98.244.5.4` to `76.33.238.13` to
`172.58.117.200`. The server log showed a residential city proxy timeout and
location fallback, then a mobile rotation, then a new proxy allocation during
resume. The original test compared resume to the **initial** residential
metadata, which was too weak to identify the violated invariant.

With the live test comparing against the **immediately preceding mobile**
session, the same focused command failed on the old selection path:

```text
cd back-end && CONDUCTOR_PORT=55170 bash scripts/run-blackbox-tests.sh browser-provider
FAIL live Kernel provider parity: resume lost the rotated proxy choice:
before={"provider":"kernel","proxy_source":"kernel_mobile_city","proxy_location":{"country":"US","state":"CA","city":"san_francisco"},...}
after={"provider":"kernel","proxy_source":"kernel_residential_city","proxy_location":{"country":"US","state":"CA","city":"san_francisco"},...}
0 passed, 1 failed, 1 total
```

This failed run is recorded at
`.context/test-runs/1790813260-45006-26315/runner.log`. Its IP ladder was
`161.115.49.67 → 187.14.92.240 → 172.56.43.190`.

## Diagnosis

Critical path: agent geo → Kernel candidate selection → `BrowserSession` row →
`rotate-proxy` → pause → `recreateKernelSession` → Kernel candidate selection →
resume API metadata. `createRemoteSession` returned the resolved source and
location, but `persistBrowserSessionRow` and the rotation update stored only
`proxyTier`. Resume therefore called `createRemoteSession` without the last
choice. It restarted the default residential search and could pick a different
location fallback or silently leave the mobile tier. The first bad boundary is
the missing per-session proxy source in the durable row; the wrong resume
metadata is downstream.

Step 5a: Why did resume change the proxy? It reselected from defaults. Why was
that possible? The session row represented the rotation count and tier but not
the proxy type plus location specificity that actually resolved. The general
problem is that a persistent session invariant was absent from its persisted
contract. The same gap affects state/country fallback and mobile rotation.

Archive searches: `resume lost resolved proxy fallback metadata` and `Kernel
browser rotation pause resume proxy source specificity`. The closest entries
were `2026-07-13-stale-cached-provider-session-id-spawns-second-browser` and
`2026-07-20-transient-proxy-init-failure-classified-fatal`. They involve a
different first bad boundary; this is a new case. The adversarial RCA review
found that the original test compared the wrong sessions and that legacy rows
needed a mobile-tier path; both were addressed before closing the diagnosis.

## Solution

Persist `kernelProxySource` on the task's BrowserSession at creation,
rotation, and challenge recovery promotion. Resume selects the recorded
managed tier and location specificity; a new rotation still overrides it.
Steel replacement clears the Kernel source. A committed Prisma migration
adds the nullable column. The field cannot be derived from `proxyTier` because
the latter has no city/state/country specificity, and a deleted remote session
is not a durable source. A context-level preference cannot safely represent
concurrent sessions. The nullable column and one legacy branch are needed for
active sessions that cross the rollout: an older null-source mobile row remains
mobile, though its exact location specificity cannot be reconstructed. This
branch is limited to null-source rows.

The permanent `browser-provider` blackbox checks selection from a recorded
mobile state fallback, the legacy null/mobile row, configured proxy handling,
and rotation override. Its live parity leg compares the resumed source,
location, and proxy ID with the last mobile session before pause. With the old
selection behavior, the fast blackbox command
`./node_modules/.bin/tsx src/tests/blackbox/browser-provider.blackbox.ts`
failed `resume must select the recorded mobile state proxy` (exit 1). With the
fix, the identical command passed `Kernel resume keeps the resolved proxy tier
and fallback location` and all 14 cases (exit 0).

The same live command shown under Problem then passed unchanged with the fix:
`PASS browser-provider (119443ms)`, `1 passed, 0 failed` (exit 0), recorded
at `.context/test-runs/1790813375-52298-2894/runner.log`. The full deploy
coverage gate also discovers this domain.

10k-agent behavior: one nullable text value per browser session. Resume makes
no new provider call or global coordination; it uses the existing managed
proxy cache.

## Human feedback

None recorded.

## Reusable lesson

Persist the resolved per-session provider choice before any pause or rotation can recreate the remote session.
