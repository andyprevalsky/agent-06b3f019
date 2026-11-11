---
id: 2026-11-11-entry-404-cached-immutable-defeated-reload-recovery
date: 2026-11-11
title: Entry-load recovery reloaded onto a browser-cached immutable 404 for the entry chunk and stranded the page on the static shell across a deploy switch
surface: front-end
component: index-html-entry-bootstrap
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/index.html entry-load recovery — location.reload() reused the browser-cached 404 (Cache-Control immutable) for the failed entry chunk instead of asking the edge again
symptoms:
  - "Error: locator.boundingBox: Test timeout of 180000ms exceeded."
  - "waiting for locator('header').first()"
  - "header is centered and never wider than the 390 px viewport"
  - "[EntryLoad] https://www.roselabs.ai/assets/index-CHgSjGvd.js failed to load; reloading"
  - "404 for /assets/index-*.js with cache-control: public, max-age=31536000, immutable"
tags:
  - vercel
  - deploy-switch
  - entry-chunk-404
  - http-cache
  - immutable
  - static-shell
  - semantic-gate
  - flaky-e2e
sources:
  - commit ebe427a5e97f0e24f865d5befe2564d9768bf399
  - PR #1933
repro: front-end/tests-e2e/entry-load-recovery.spec.ts
status: fixed
---

## Problem

The production semantic gate (`chat-lifecycle-ratchet.yml`, "Semantic frontend
flows", run 43048557777 for source ebe427a5e, 4 workers) failed
`mobile-layout.spec.ts:194 › header is centered and never wider than the 390 px
viewport` with `locator.boundingBox: Test timeout of 180000ms exceeded` while
`waiting for locator('header').first()`. The page snapshot and screenshot showed
only the static `About · Privacy · Terms` shell from `index.html`: React never
mounted, so no `<header>` ever existed.

## Diagnosis

1. Vercel's deployments API: 84853969a became READY (and production) at
   15:31:03Z. The test navigated at 15:31:07Z, mid-run of the gate for the
   previous deploy (every production deploy triggers this gate, so later merges
   switch the alias under running tests).
2. Trace network: the first document was the previous build's edge-cached HTML
   (`age: 220`), whose entry `index-C80jF-dk.js` returned 404. The recovery
   reloaded onto the new HTML (`age: 1`), whose entry `index-CHgSjGvd.js` also
   404'd once at a not-yet-switched edge node.
3. Every later request for `index-CHgSjGvd.js` (15:31:08.7, 09.8, 11.8) carried
   the same `x-vercel-id` (`sfo1::fk9xx-1794411068107-…`) and `Date: 15:31:08`:
   Chrome served them from its HTTP cache. Vercel sends missing `/assets/*` files
   as `404` with that path's `cache-control: public, max-age=31536000,
immutable` (verified with curl on a nonexistent asset), and a reload does not
   revalidate immutable subresources. The 3 bounded reloads all replayed the
   cached 404; the budget was spent and the page stayed on the static shell.
4. The 2026-11-06 regression (`entry-load-recovery.spec.ts`) used `page.route`,
   which disables Playwright's HTTP cache, so it could never observe this.

Local reproduction: a real origin in front of the frontend that answers the
first entry request with `404` + the immutable header (no `page.route`). The new
spec test failed on production and on a local build with the old recovery
script (one entry request reached the origin; three cached replays). The exact
unchanged `mobile-layout.spec.ts:194` test run through that origin against
production with the unfixed HTML failed with the identical
`locator.boundingBox: Test timeout of 180000ms exceeded … waiting for
locator('header').first()`. The 10k/100k MASSIVE_SAMPLE long tasks were not
causal: the page never loaded its bundle.

## Solution

`front-end/index.html` recovery now refetches the failed entry with
`fetch(src, { cache: 'reload' })` (bounded by 5 s) before `location.reload()`.
That request bypasses the HTTP cache and replaces the cached 404 with the
edge's current answer, so a reload after the switch finishes loads the live
entry. Attempt budget (3 per entry URL), backoff and offline handling are
unchanged. New spec test: "an entry 404 cached as immutable is refetched before
the reload and the app mounts" (fails pre-fix, passes post-fix, 5/5 repeats).
With the fix, the unchanged assigned test passes through the same cutover
origin. Cost: one extra GET per recovery attempt, only on a failed entry load;
no backend or per-agent work (10k-agent neutral).

## Human feedback

None recorded.

## Reusable lesson

When a reload-based recovery for a missing hashed asset never succeeds, check whether the 404 carries an immutable Cache-Control and is replayed from the browser cache; tests built on page.route cannot see it because routing disables the HTTP cache.
