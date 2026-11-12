---
id: 2026-11-11-semantic-helper-evaluate-raced-app-version-reload
date: 2026-11-11
title: Semantic session-injection page.evaluate died when the app reloaded onto a deploy promoted mid-run
surface: front-end
component: tests-e2e-session-injection-helpers
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/helpers.ts injectSemanticSession/expectInjectedSessionRecognized — page.evaluate assumed the document from page.goto survives, while src/lib/appVersion.ts reloads once on load when /version.json names a newer build
symptoms:
  - "Error: page.evaluate: Execution context was destroyed, most likely because of a navigation"
  - "at injectSemanticSession (helpers.ts:160) ← expectInjectedSessionRecognized (helpers.ts:167) ← waitForDevLogin (mobile-layout.spec.ts:70)"
  - "mobile-layout.spec.ts:194 › mobile-layout › header is centered and never wider than the 390 px viewport"
  - "[AppVersion] build 80e281dbd690-mwci3llv replaced by 0f8f6da44611-mwciaef1 (load); reloading"
  - "Production semantic gate fails once right after a merge to main with no front-end change"
tags:
  - semantic-gate
  - production-semantic
  - deploy-switch
  - vercel
  - app-version-reload
  - playwright
  - flaky-e2e
sources:
  - PR #1936
  - commit 0f8f6da4461195bcc720481ef52375fa511f7fb1
  - commit 7b946966b64ccab10aec7306da115b50e933af4c
  - commit 1bdd93f9a0db300a1ead88685049c3edcec08281
  - PR #1951
  - commit 7fa4b30656b23fb53000864cbff0cd5c1fbd9f83
repro: front-end/tests-e2e/app-version-reload-session.spec.ts
status: fixed
---

## Problem

The production semantic gate (`chat-lifecycle-ratchet.yml` → "Semantic frontend
flows", run 43085818750, source 0f8f6da44 from PR #1936) failed one test:
`mobile-layout.spec.ts:194` threw `page.evaluate: Execution context was
destroyed, most likely because of a navigation` inside `injectSemanticSession`
(helpers.ts:160). The other 51 tests passed. PR #1936 changed no front-end
bytes, but Vercel still built and promoted 0f8f6da44, because every main push
gets a new build id (`vite.config.ts` `productionBuildId`).

The failure trace (`trace.zip`) shows the page's HTML/bundle was the previous
build `80e281dbd690-mwci3llv`. About 1.3 s after DOMContentLoaded, the app's
`load` version check logged
`[AppVersion] build 80e281dbd690-mwci3llv replaced by 0f8f6da44611-mwciaef1 (load); reloading`.
The helper's pending `page.evaluate` (started 0.7 s after DCL, delayed by app
boot on the busy 4-vCPU runner) ran on the document that reload destroyed.

## Diagnosis

1. `src/lib/appVersion.ts` reloads an open page once per tab session (guarded in
   sessionStorage) when `/version.json` names a different build. That is
   intended production behavior: stale PWAs/tabs move onto the live deploy.
2. The production gate runs against the live site right after a merge, while
   Vercel's production deployment of that merge (or any later merge) can
   promote. A test page can therefore load the old HTML and then see the new
   `/version.json`.
3. `injectSemanticSession` / `expectInjectedSessionRecognized` called
   `page.evaluate` immediately after `page.goto` and assumed that document
   survives. The first app-initiated reload destroyed the context, so the test
   failed before it reached any layout assertion.

Local reproduction: a production `vite build` served by `vite preview` on
`localhost:8080` (an origin the production backend allows by CORS), with
`/version.json` overwritten to a newer id, the prod backend, and the minted
ratchet session (`generate-prod-test-session.mjs`, user 606fe9fc). Running the
unchanged `mobile-layout.spec.ts -g "header is centered"` failed 6/6 with the
identical stack (helpers.ts:160 ← :167). The control (matching `/version.json`)
passed 3/3, so the reload is the cause.

## Solution

`front-end/tests-e2e/helpers.ts` `acrossAppReload` (commit 7b946966b, by the
concurrent PR #1940 repair owner) repeats a step only when the main frame
requested a new document beyond the step's own navigations, waits for that
document's DOMContentLoaded, and retries at most twice. Other errors still
fail. It wraps the session writes, the reload, the session read and the
mobile header-centering read. Assertions and timeouts are unchanged.

Verification on the same local stale-build origin: the unchanged test passes
10/10. The end-to-end regression `app-version-reload-session.spec.ts` (routes
`/version.json` to a newer id, then runs the real helpers against the real app)
failed 5/5 before the fix and passes 15/15 after. It runs in the deploy semantic
stack lane (bundled `vite build` with a build id) and in the production gate. It
skips on a dev server with no build id. 10k-agent behavior: test-only; no
runtime path changes.

Shipped in PR #1951 (merge 7fa4b3065). The production semantic gate on that
merge (run 43099651687) passed 55 tests with 0 failures, including
`mobile-layout.spec.ts:195` and the new regression. The first dispatch ended
in `startup_failure` during GitHub's 2026-11-11 Actions incident and was rerun
after recovery.

Not fixed here (recorded for follow-up): the gate can still start before
Vercel finishes promoting the merge. `scripts/deploy_prod.py` enables the
`vercel` lane (which `semantic` depends on) only when `front-end/` changed. Yet
every main push promotes a new build id: 80e281dbd, 0f8f6da44 and 1666ab29c,
all with no front-end files, promoted within 9 minutes on 2026-11-11. The
workflow also runs on every Vercel production `deployment_status`. Other merges
can therefore promote during any run, and test steps must tolerate one app
reload rather than rely on deploy timing. A read-only audit of `tests-e2e`
found more prod-mode `page.evaluate` / locator-evaluate calls within seconds
of a `goto`, without navigation tolerance:
`phone-app-adapter.spec.ts:131`, `projects-sidebar-flow.spec.ts:234/250`,
`entry-load-recovery.spec.ts:88`, `sidebar-agent-tree.spec.ts:316/368/381`,
and lower risk `agent-display-panel:112`, `project-folder-controls:122`,
`trajectory-work-carousel:151`, `mobile-adversarial-media:53/60` and
`mobile-performance.ts:199/215`. The periodic 5-minute check
(`appVersion.ts`) can also reload long specs after 2 minutes without input. Request-only detection can miss a reload whose document
request began before the step started. The helper's negative control in
`app-reload-helper.spec.ts` uses the real app, so a mid-run promotion can also
make it retry. Both were reported to the helper owner.

## Human feedback

None recorded.

## Reusable lesson

A production-facing Playwright step must tolerate the app's own one-shot reload onto a newly promoted build; treat "Execution context was destroyed" right after a merge as a deploy-switch race and test it by advertising a newer /version.json.
