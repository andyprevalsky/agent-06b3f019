---
id: 2026-11-06-entry-chunk-404-after-deploy-switch-stranded-static-shell
date: 2026-11-06
title: A page loaded across a production deploy switch requested its entry chunk after it was removed and stayed on the static footer shell
surface: front-end
component: index-html-entry-bootstrap
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/index.html module entry script — a failed entry module graph had no recovery outside the bundle that failed to load
symptoms:
  - "TimeoutError: locator.click: Timeout 30000ms exceeded."
  - "waiting for getByRole('button', { name: 'Open menu', exact: true })"
  - 'page snapshot shows only contentinfo with link "About", "Privacy", "Terms"'
  - "10k message details, source links and mobile/desktop copy menus remain usable"
  - "blank page with only About · Privacy · Terms after deploy"
tags:
  - vercel
  - deploy-switch
  - stale-html
  - entry-chunk-404
  - static-shell
  - semantic-gate
  - flaky-e2e
sources:
  - commit 0ee70b27c83a9ac586a958fb3db4df8f5e5d9c32
repro: front-end/tests-e2e/entry-load-recovery.spec.ts
status: fixed
---

## Problem

The production semantic gate (`chat-lifecycle-ratchet.yml`, "Semantic frontend
flows", GitHub Actions run 42191005446 attempt 1, 08:54-08:59Z) failed once on
merged source 0ee70b27c:
`mobile-adversarial-trajectories.spec.ts:327` timed out after 30 s waiting for
the mobile "Open menu" button on its very first `select()` after `page.goto`.
The same job passed on attempt 2 and no `front-end/` file changed.

The failure artifact's page snapshot contained only
`contentinfo: link "About" · link "Privacy" · link "Terms"` and the screenshot
was a blank page with that footer at the top. That is the static
`<footer class="rose-static-links">` inside `#root` in `front-end/index.html`,
not the React `TerminalLegalFooter` (which renders "About" as a button at
390 px): React never mounted during the 30 s.

Vercel's deployment API showed production deployment 9a4a20f60 READY at
08:58:19Z and 0ee70b27c READY at 08:59:10Z; the failing test started at
08:59:16Z. Each build bakes a unique `VITE_ROSE_BUILD_ID`, so entry chunk names
change on every deploy even without frontend changes, and the project has no
skew protection. After a later switch the previous entry
(`/assets/index-BPCOfZSh.js`) returned `404 text/plain` on www.roselabs.ai while
the unchanged CSS hash still returned 200 (hence the styled but empty shell).

## Diagnosis

1. `index.html` is edge-cached (`x-vercel-cache: HIT`, `must-revalidate`), so a
   document from one build can be served or held while the domain's assets
   already resolve against another deployment.
2. The document's hashed module entry (or a static dependency) 404s, the module
   graph fails, and `main.tsx` never runs.
3. The only stale-build recovery (`src/lib/appVersion.ts`: `/version.json`
   check and `vite:preloadError` reload) lives inside that bundle, so nothing
   reloads. The user is stranded on the static links forever.

Local reproduction against the then-current production build: the original
test body, unchanged, plus a route returning 404 once for
`/assets/index-*.js` failed with the identical `TimeoutError` at `select` and
the identical footer-only page snapshot. `entry-load-recovery.spec.ts` failed
on production (no mount; 1 document load instead of 4) before the fix.

The 10k history and long tasks in MASSIVE_SAMPLE were not causal: the page
never reached the agent list.

## Solution

A classic inline script in `front-end/index.html`, ahead of the module entry,
listens (capture phase) for an `error` event on a module `<script src>` and
reloads the page so the live build's HTML loads. It retries with 0.5/1/2 s
backoff, at most three times per entry URL (sessionStorage, window.name
fallback), and not while offline, so a genuinely missing build cannot loop.

With the fix, the original test plus the injected entry 404 passed 5/5 and the
unchanged original test passed 5/5 on a local production build;
`entry-load-recovery.spec.ts` (recovery and the reload bound) passed 5/5 on the
production build and 5/5 on the dev server. It runs in the semantic suite
locally in /deploy and against production after each merge. Per-client cost is
one passive listener; no backend or per-agent work (10k-agent neutral).

## Human feedback

None recorded.

## Reusable lesson

When an E2E page shows only the static index.html shell, check for a production deploy switch and make sure entry-load failures can recover outside the bundle that failed.
