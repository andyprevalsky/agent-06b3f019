---
id: 2026-11-14-entry-load-count-attributed-next-build-recovery-reload
date: 2026-11-14
title: Entry-load offline-backoff test counted the next build's own entry-recovery reload after a production deploy switched the alias mid-test
surface: front-end
component: tests-e2e-entry-load-recovery
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/entry-load-recovery.spec.ts countDocuments — counted every main-frame document request as a reload of the build under test, while a production alias switch handed the reload a newer build whose own entry 404'd at an edge node that served the new HTML before it held the new assets, triggering that build's own (correct) recovery reload
symptoms:
  - "expect(loads.count).toBe(2)"
  - "Received: 3"
  - "connectivity lost during the backoff waits for online without spending an attempt"
  - "entry-load-recovery.spec.ts:160"
  - "[EntryLoad] https://www.roselabs.ai/assets/index-DU45tssp.js failed to load; reloading"
tags:
  - vercel
  - deploy-switch
  - entry-chunk-404
  - semantic-gate
  - production-semantic
  - flaky-e2e
  - navigation-count
sources:
  - commit e54032c7fba36b09b58b5a83fef7754f89df716f
  - commit 7a170d4172
  - PR #2021
repro: front-end/tests-e2e/entry-load-recovery.spec.ts
status: fixed
---

## Problem

The production semantic gate (`chat-lifecycle-ratchet.yml`, "Semantic frontend
flows", run 43638239542 attempt 1, dispatched by `scripts/deploy production
--lanes semantic` for PR #2021, source e54032c7f) failed
`entry-load-recovery.spec.ts:131 › connectivity lost during the backoff waits
for online without spending an attempt` at its last line,
`expect(loads.count).toBe(2)` → `Expected: 2, Received: 3`. Every earlier
assertion passed: no offline reload at 2 s, static links visible, no attempt
charged, and the app mounted ("Open menu" visible) once online. Attempt 2 on the
same SHA passed.

## Diagnosis

1. Trace network (main-frame documents and entry chunks only):
   - 20:36:23.307 `page.request` HTML for `entryPath()`: `age: 607`, entry
     `/assets/index-B0XDmoYQ.js`.
   - 20:36:23.355 document 1 (`goto`): same old HTML (`age: 607`); its entry
     `index-B0XDmoYQ.js` is the routed 404 while offline.
   - 20:36:25.613 online: revalidate fetch of `index-B0XDmoYQ.js` (200), then
     20:36:25.662 document 2 (`location.reload()` by document 1's recovery):
     **new** HTML (`age: 1`, edge node `ql6g8`) naming
     `/assets/index-DU45tssp.js`, which 404'd 80 ms later at edge node
     `sfo1::xzzqg` (79-byte 404 with `cache-control: public, max-age=31536000,
immutable`, not routed by the test); 570 ms later node `jczk8` served it
     as a 200 cache HIT. For under a second the edge served the new HTML before
     every node held its assets.
   - 20:36:26.326 document 2's own recovery revalidated `index-DU45tssp.js`
     (200) and 20:36:26.380 reloaded: document 3 (`age: 2`) loaded the entry
     and mounted.
2. Vercel deployments API: production deployment of 7a170d4172 (PR #1635)
   became READY at 20:36:23Z, between document 1 and document 2. The old HTML's
   `age: 607` matches cb570c2cfe's READY at 20:26:14Z. Every production deploy
   (and every main push promotes a build) runs this gate, so alias switches
   under a running test are an expected condition (also noted by
   2026-11-11-entry-404-cached-immutable-defeated-reload-recovery and
   2026-11-11-semantic-helper-evaluate-raced-app-version-reload).
3. The product did the right thing: document 1 reloaded exactly once, only
   after `online`, charging one attempt to its own entry URL; document 2 (a
   different build) recovered from its own entry 404 with its own budget. The
   test's `countDocuments` counted every main-frame navigation, so it charged
   the next build's recovery reload to the build under test.

Why ladder: (1) why 3? the newer build's own recovery reload was counted;
(2) why was it counted? the counter had no notion of which document issued a
navigation; (3) why could another build appear? the live production alias is
the system under test and is switched by concurrent deploys. Rung 3 is outside
this test's control (gate dispatch timing is a known separate follow-up in the
2026-11-11 app-version case), so the fix is at rung 2.

Local reproduction: a real origin in front of the frontend that serves the
first document unchanged and later documents naming a `-next` entry path that
404s once, then serves (`serveDeploySwitchAfterFirstDocument`). The new spec
test drives the identical offline-backoff scenario through it. With the old
counter, against production:
`FRONTEND_URL=https://www.roselabs.ai npx playwright test
tests-e2e/entry-load-recovery.spec.ts -g "deploy switch"` → failed at the
final `expect(loads.count).toBe(2)` with `Expected: 2, Received: 3` after every
product assertion passed (3 documents; the next build charged once to its own
entry URL; app mounted).

## Solution

`countDocuments(page, entry)` counts the first document and the documents
requested by a document of the build under test: one whose main-frame
navigation response was followed by a request for `entry`. A document of
another build (which never requests `entry`) no longer adds its own recovery
reloads. Duplicate reloads issued by a build-under-test document are still
counted, because the document stays "under test" until the next navigation
response. All five existing tests pass `entry` to the counter; their assertions,
timeouts and intent are unchanged. The proxy plumbing is shared by
`serveFrontend`, used by the cached-immutable origin and the new deploy-switch
origin.

Regression: `entry-load-recovery.spec.ts › a deploy switch during the offline
backoff: the stale document reloads once and the next build recovers itself`
(fails pre-fix with the production error, passes post-fix). It also asserts the
neighbouring behaviour that must not change: 3 real documents, one charge per
entry URL, and the app mounts. Verified: the identical command above passes;
the full spec passes 6/6 against production and against a local
`ROSE_E2E_FIXTURES=true vite build` served by `vite preview` (the deploy
semantic-stack shape); the new and the assigned test pass 5/5 consecutive
repeats on both targets, and the whole spec passes 12/12 (2 repeats) with every
core busy. It runs in the deploy semantic-stack `ui` lane (every spec except
chat latency, per `deploy_test_semantic.py`) and in the production semantic
gate. `select_affected_tests.py --lanes-for` reports NOT RUN for every
`tests-e2e` spec because its lane model does not include the Playwright
semantic lanes; that gap predates this change.

Remaining same-class exposure (recorded, not fixed here): after an alias
switch, a _mounted_ document of the build under test can also reload through
`src/lib/appVersion.ts` (newer `/version.json`, or `vite:preloadError`). By
request attribution that is indistinguishable from the recovery script wrongly
reloading a mounted page, which these counts must keep catching, so the
counter deliberately still counts it. Not observed in this incident.
Two more switch windows stay exposed and are recorded for follow-up: a switch
between `entryPath()` and `goto` (the route then never matches the served
entry), and a switch during "an entry that never loads stops after three
bounded reloads" (a new entry URL gets its own budget). Removing every window at
the source means pinning these stale-document tests to the immutable
per-deployment URL instead of the moving alias (deployment protection from CI
unverified), or detecting a mid-test build change explicitly.

Independent review (RCA step 7): a fresh sub-agent given only the symptom,
trace and repro named the same first bad boundary (the next build's edge 404 at
20:36:25.780Z after its HTML at 25.701Z) and classification, and confirmed
`appVersion.ts` did not reload (`/version.json` matched the running bundle).
Its event-ordering concern was resolved by the flakiness cross-review, which
read Playwright 1.64's network dispatch (a navigation `response` is emitted as
soon as Chromium reports it; a request event precedes its route handler) and
by construction: each recovery reload follows that document's own entry
revalidate fetch, which re-arms the counter.

10k-agent behaviour: test-only; no runtime path changes.

## Human feedback

None recorded.

## Reusable lesson

A production E2E test that counts navigations must attribute each one to the
document (build) that issued it, because the live alias can switch builds
between two documents of one test.
