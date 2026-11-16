---
id: 2026-11-15-entry-load-fault-bound-to-separate-html-fetch-across-deploy-switch
date: 2026-11-15
title: Entry-load bounded-reload test faulted the entry named by a separate HTML fetch, which a production alias switch 70 ms later made another build's
surface: front-end
component: tests-e2e-entry-load-recovery
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/entry-load-recovery.spec.ts entryPath/failEntry — resolved the entry to fault from a page.request HTML fetch (build CqDStlLY, last-modified 06:43:44Z) instead of the document the browser navigated to 70 ms later (build QmSoGpxy, last-modified 06:44:16Z), so the 404 route matched nothing and the live entry mounted
symptoms:
  - "an entry that never loads stops after three bounded reloads"
  - "entry-load-recovery.spec.ts:175"
  - "Expected: 4"
  - "Received: 1"
  - "Timeout 20000ms exceeded while waiting on the predicate"
tags:
  - vercel
  - deploy-switch
  - entry-chunk-404
  - semantic-gate
  - production-semantic
  - flaky-e2e
  - playwright-route
  - fault-injection
sources:
  - PR #2229
  - commit 1f7bbe84e708eeb88108737491219fa43f93ac40
  - PR #2205
  - commit 9d6a810aeabb9e96734ed50a843bd9f058c2b731
  - PR #1922
  - PR #2110
  - commit 3b50a5906fd22e13d16a163d2f9ecc40e9081c18
repro: front-end/tests-e2e/entry-load-recovery.spec.ts
status: fixed
---

## Problem

The production semantic lane (GitHub Actions run 43686704518, chat-lifecycle-ratchet.yml,
dispatched by the /deploy of PR #2205 at merge 9d6a810aea, 2026-11-15 06:44Z, against
https://www.roselabs.ai) failed `entry-load-recovery.spec.ts:175` "an entry that never loads
stops after three bounded reloads": `Expected: 4`, `Received: 1`, `Timeout 20000ms exceeded
while waiting on the predicate`. Its page snapshot shows the mounted app (the "Open menu"
banner and the onboarding prompt), not the static links, so the entry never failed. PR #2205
changed only a Python test, which makes this NOT_INTRODUCED for that deploy.

## Diagnosis

The run's trace (`0-trace.network`) has two HTML responses for `/?no-auto-login`:

- 06:44:17.337Z, from `entryPath()`'s `page.request.get`: age 33, last-modified 06:43:44Z,
  module entry `/assets/index-CqDStlLY.js`;
- 06:44:17.408Z, from `page.goto`: age 0, last-modified 06:44:16Z, module entry
  `/assets/index-QmSoGpxy.js`, which then loaded with a 200.

Vercel promoted a new production build at 06:44:16Z, between the two requests. `failEntry`
routed the pathname from the first HTML, so the navigated document's entry was never routed.
React mounted, the recovery script never ran, and `countDocuments` saw only the first document.
The second deploy's run 43686929632 (06:47Z) shows the same burst of promotions (HTML
last-modified 06:46:29Z, then 06:47:18Z). Why ladder: the fault injection was bound to a
document other than the one under test. Every production deploy starts this suite, so the
alias moving mid-suite is normal (run 43638239542, case
2026-11-14-entry-load-count-attributed-next-build-recovery-reload). Any test that resolves the
build under test through a separate request is racing that promotion. PR #1922 (open since
2026-11-11, never merged) diagnosed the same skew against an older revision of this spec.

Local repro, identical command before and after: `FRONTEND_URL=http://127.0.0.1:4918 npx
playwright test tests-e2e/entry-load-recovery.spec.ts -g "stops after three bounded reloads"`.
It runs through a proxy that makes every HTML request a newer build of a local `vite preview`
production build. Unfixed: FAIL `Expected: 4 Received: 1` after the 20 s poll. Fixed: PASS.
An independent sub-agent named the same first bad boundary from the trace alone. It also found
a per-document rebind regression in an earlier draft of the fix (`countDocuments` counted the
next build's own recovery reload), plus the unfixed origin-based sites; both are fixed below.

## Solution

The build under test is now the first document the browser navigated to, never a separate
fetch. `routeEntry` routes main-frame navigations, `route.fetch()`es the document, and latches
the entry from the first one before fulfilling that same response. A first document without a
module script (an error or challenge page) fails loudly instead of hanging the route. While
`failEntry`'s budget is unspent, reloads replay the first document, so each one names one
entry as a stale edge-cached document does. The three-attempt budget then stays scoped to one
entry URL even if production promotes again mid-test. `failEntry` (the stale-document and
never-loads tests) and the two page.route-based offline tests use it. The two origin-based
tests (immutable cached 404, offline deploy switch) now bind the entry from the first document
their proxy forwards. `entryPath()`'s separate fetch is gone. Assertions and timeouts are
unchanged. `countDocuments` receives the latched entry, which keeps the
2026-11-14 attribution intact.

Regressions in the owning spec:
- "an entry that never loads is faulted on the navigated document across a deploy switch"
  serves a newer build on every HTML request, after a separate HTML fetch. It asserts four
  documents and static links, that exactly two builds were served, and that only build 2's
  entry was faulted. It fails on the old binding with `Received: 1`.
- "a stale document that reloads onto a build whose entry 404s once counts only its own
  reload" is the negative control. It fails when the entry is rebound per document (the
  reviewer's `Expected 2, Received 3` overbroad variant).
The whole spec passes 40/40 with `--repeat-each=5` on a local production build.

The cached-404 test's observed failure in run 43686929632 (`Expected: 2 Received: 3`) is a
different mechanism (appVersion's reload onto a newer build after mount) and stays a
follow-up. Shipped in PR #2229 (merge 1f7bbe84e7); production semantic run 43809390145 passed on that SHA with all
eight entry-load tests green. Test-only change; no runtime or 10k-agent impact. The spec runs in the deploy
semantic-stack `ui` lane (every spec except chat latency, per `deploy_test_semantic.py`) and in
the production semantic gate. `select_affected_tests.py --lanes-for` reports NOT RUN for every
`tests-e2e` spec because the mapper does not register the semantic lanes, a gap that predates
this change (also recorded in 2026-11-14-entry-load-count-attributed-next-build-recovery-reload).

## Human feedback

None recorded.

## Reusable lesson

Bind a production E2E fault injection to the exact response the browser navigated to, never to a separate fetch that a deploy promotion can answer with another build.
