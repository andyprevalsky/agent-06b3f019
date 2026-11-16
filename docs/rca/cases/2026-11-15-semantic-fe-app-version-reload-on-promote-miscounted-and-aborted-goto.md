---
id: 2026-11-15-semantic-fe-app-version-reload-on-promote-miscounted-and-aborted-goto
date: 2026-11-15
title: Production semantic frontend tests broke when another merge's Vercel build was promoted mid-test; the app's one-shot version reload was counted as an entry-recovery reload and cancelled a test navigation
surface: front-end
component: tests-e2e-app-reload-harness
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/entry-load-recovery.spec.ts countDocuments counted the build under test's src/lib/appVersion.ts load-check reload (newer /version.json after a promote) as an entry-recovery reload; front-end/tests-e2e/sidebar-agent-tree.spec.ts navigated home with a bare page.goto while the preview document's load check could still reload it, and helpers.ts acrossAppReload could not recover a navigation cancelled that way
symptoms:
  - "expect(loads.count).toBe(2)"
  - "Received: 3"
  - "page.goto: net::ERR_ABORTED at https://www.roselabs.ai/"
  - "(load); reloading"
  - "composer controls are flush bottom left with attach before the model at 320px"
tags:
  - vercel
  - deploy-switch
  - app-version-reload
  - semantic-gate
  - production-semantic
  - flaky-e2e
  - navigation-count
  - err-aborted
sources:
  - PR #2184
  - commit b7ea782519edf3234e93d187a657d06cd98233fe
  - PR #2221
  - commit 55655e654472c4ae54edcb4540ae16a808e142b6
  - PR #2110
  - PR #1951
repro: front-end/tests-e2e/entry-load-recovery.spec.ts, front-end/tests-e2e/sidebar-agent-tree.spec.ts, front-end/tests-e2e/app-reload-helper.spec.ts
status: open
---

## Problem

The production semantic lane's "Semantic frontend flows" job on PR #2184's merge
(b7ea782519; GitHub Actions run 43686929632, job 132729249383) reported 2 failed
and 58 passed. PR #2184 changes no `front-end/` file. Between 06:40Z and 06:51Z
Vercel promoted another merge's production build about once a minute.

1. `entry-load-recovery.spec.ts:156` "an entry 404 cached as immutable is
   refetched before the reload and the app mounts" failed with
   `expect(loads.count).toBe(2)`, received 3 (`:168:25`).
   - The trace shows three documents on the test's proxy origin.
   - Document 1 (06:47:17.239Z) got the cached-404 entry `index-rSO5p7zd.js`
     and logged `[EntryLoad] ... failed to load; reloading`.
   - Document 2 (06:47:18.040Z, same build) loaded the entry and mounted.
     Its load check `GET /version.json` (06:47:18.629Z) returned
     `c680f58fe7fe-mwhh1tqd`, which had just been promoted.
   - Document 2 then logged `[AppVersion] build e0674ff61d12-mwhh0ui8 replaced
     by c680f58fe7fe-mwhh1tqd (load); reloading`.
   - Document 3 (06:47:19.229Z, Age 0, new build) was counted, because the
     document that issued it had requested the entry.
2. `sidebar-agent-tree.spec.ts:317` (320px) failed with
   `page.goto: net::ERR_ABORTED at https://www.roselabs.ai/` after 1.4 s.
   - `openSidebarPreview` loaded `/?agent-id=launch-root` (build
     9d6a810aeabb), and the test immediately navigated home (`:321`).
   - The preview document's load check (`version.json` at 06:48:18.102Z)
     returned `c3efd5060f42-mwhh3534`. It logged `[AppVersion] ... replaced
     by ... (load); reloading` and called `location.reload()`.
   - That reload (06:48:18.319Z) cancelled the pending `GET /` (06:48:18.289Z).

A second occurrence of (1), reported by PR #2221's deploy thread: production
semantic run 43691173465 (job 132741958284, merge 55655e6544, docs-only).
`:156` failed with the same `Expected: 2 Received: 3` at `:168:25` while it ran
07:44:16–07:44:19Z, with f6a9e3b47b promoted at 07:44:15Z and 8207c0b361 at
07:44:19Z.

Evidence: the run's Playwright artifacts, downloaded to
`/var/tmp/semfe-repair/art` and unpacked to `/var/tmp/semfe-repair/tr`
(trace, video, error-context for both tests). The deploy-switch timing comes
from the GraphQL `repository.deployments` (Production) evidence in the repair
packet.

## Diagnosis

The critical path: Vercel promotes a newer build → the open document's
`src/lib/appVersion.ts` `initAppVersionWatch` `check('load')` →
`fetchDeployedBuildId` returns a different id → `reloadOnce` →
`location.reload()`.

The app behaves as designed. It reloads once per session per target, the
behavior the app-version blackbox test and `app-version-reload-session.spec.ts`
assert. The first wrong data is in the harness:

- `countDocuments` attributes every document requested by a build-under-test
  document to that build's entry recovery. The PR #2110 case recorded this
  exposure ("a mounted document of the build under test can also reload through
  appVersion.ts ... the counter deliberately still counts it"), because request
  attribution alone cannot tell it apart from a wrong recovery reload. This
  incident is that exposure firing.
- The sidebar test issues a second navigation within a second of the previous
  document's DOMContentLoaded, before that document's load-time version check
  has settled, with a bare `page.goto`.
- `acrossAppReload` (PR #1951) would not have recovered it either. The
  cancelled `page.goto` rejects before Playwright reports the reload's `request`
  event (`documents` = 1 = `ownNavigations` at the catch). In the late branch the
  aborted navigation never loads, so `loads` never exceeds `ownNavigations`. This
  was observed: the sidebar regression failed with ERR_ABORTED inside
  `acrossAppReload` before the helper fix.

Why was this possible? Every main merge promotes a new build id, and the
production semantic job runs while other merges promote. Any test step that
counts documents, or navigates while a version check is pending, sees one extra
app-initiated document. The harness had no way to attribute that document to
appVersion. The deepest owned rung is the harness's attribution of app-initiated
documents. The app's reload is correct, and the promote cadence belongs to
deploy policy.

Classification: test bug (harness contract), not an app defect. Archive
searches run: `rca_archive.py search "entry-load-recovery Expected 2 Received 3
deploy switch"`, `"page.goto net::ERR_ABORTED AppVersion reload promote"` and
`"entry-load-recovery count documents deploy switch next build reload"`, plus a
grep of the cases for the run id and the AppVersion line. This is a recurrence
of the class in `2026-11-11-semantic-helper-evaluate-raced-app-version-reload`
(same app reload, new sites: a document count and a cancelled navigation). It
is a relative of `2026-11-14-entry-load-count-attributed-next-build-recovery-reload`,
whose recorded remaining exposure this is. Both lessons apply: tolerate the
app's one-shot reload, and attribute documents to the build under test.

Independent review (RCA step 7): a fresh sub-agent given only the symptom,
traces and test code independently named the same first bad boundary
(`appVersion.ts` `check('load')` → `reloadOnce` → `location.reload()` after a
real promote, in both failures) and the same classification. Its review of the
fix found:

- a binding-versus-request ordering race in the counter (fixed by pairing);
- a mid-test promote window in the new regression (fixed: the assertions hold
  in either case, and the first document is pinned);
- the deploy-switch offline test still exposed to live `/version.json` (fixed:
  its proxy no longer serves it);
- an own-request-never-reported variant in the helper. Rejected with evidence:
  treating any load after a failure as foreign made the negative control
  retry a genuine `route.abort()` failure (calls = 3, 5/5 runs), because Chrome
  commits an error page for the failed navigation. The app registers no
  `beforeunload` handler, so a browser-initiated goto starts its request with no
  renderer round trip, and all three observed traces report the cancelled
  request;
- unbounded fixture latches (fixed).

Decided not to change: `acrossAppReload` still retries on any new document,
not only an announced appVersion reload. That is PR #1951's reviewed contract
for every caller, including entry-load recovery reloads. Retries are capped at
2, so a reload that recurs on every attempt still fails. A one-shot
self-mismatched build id is covered by `src/tests/blackbox/app-version.blackbox.ts`
("the same build" does not reload).

## Solution

The fix is test-only, in `front-end/tests-e2e`:

- **`entry-load-recovery.spec.ts` `countDocuments`.** An init script reports
  each `rose:version-reload:<build>` guard write. appVersion writes it
  synchronously just before reloading; `chunk:` guards are excluded. The report
  goes through `page.exposeBinding`. The counter leaves the announced reload's
  document uncounted, but only when the announcing document is the build under
  test. It pairs the report with that document's request in either arrival
  order (it uncounts the in-flight counted request, or skips the next one).
  Entry-recovery reloads, chunk reloads and every other document still count.
  `versionReloads` lists each announced target.
- **`serveDeploySwitchAfterFirstDocument`.** The proxy answers `/version.json`
  with 404, so a real promote can't add documents to that test's exact counts.
- **`servesFirstDocument` (the cached-immutable test and the new regression).**
  The proxy serves its first document from the exact HTML the entry was read
  from (`liveDocument`), closing the window for a promote between reading the
  entry and the first document.
- **`sidebar-agent-tree.spec.ts` `openSidebarPreview`.** It already routes every
  `/api/**` call to deterministic fixtures, and now also answers `/version.json`
  with 404. `fetchDeployedBuildId` returns null, so no fixture document (the
  preview, or the home page that `:321`/`:367` navigate to) reloads onto a live
  promote. An earlier draft retried the home navigation through
  `acrossAppReload` instead; the flakiness cross-review showed that the home
  document's own load check then reopens the same window mid-measurement.
- **`helpers.ts` `acrossAppReload`.** After a failure it waits up to
  `LATE_RELOAD_WINDOW_MS` for a document requested beyond the call's own
  navigations. The reload that cancelled a goto is reported just after the
  goto rejects. The existing load-based late path is unchanged.

Regressions (each failed before the fix with the production error and passes
after):

- `entry-load-recovery.spec.ts` "a build promoted before the recovered document
  mounts: its version reload is not the recovery's". Pre-fix: `Expected: 2
  Received: 3`.
- `sidebar-agent-tree.spec.ts` "the sidebar fixture pages never reload onto a
  build promoted mid-test". Every lower-priority `/version.json` answer names a
  newer build. Pre-fix: `page.goto: net::ERR_ABORTED at https://www.roselabs.ai/`,
  the production error, with no timing fixture. Post-fix the promoted route is
  never reached (`promotedAnswers` 0), and the documents are exactly preview,
  then home.
- `app-reload-helper.spec.ts` "a navigation cancelled by the open document
  reloading is retried after that reload" (static fixture; pre-fix helper:
  `net::ERR_ABORTED`). Its negative control is "acrossAppReload does not retry a
  navigation that fails without a new document".

Golden reference: not applicable (no approval-gated hunk).

Where they run: the production semantic gate (`scripts/deploy production
--lanes semantic`) and the deploy semantic-stack `ui` lane (bundled `vite
build`, which has a build id). On a dev server with no build id the
production-only regressions skip. `select_affected_tests.py --lanes-for` still
reports NOT RUN for `tests-e2e` specs (the gap predates this change, recorded
in the PR #2110 case).

Remaining same-class exposure (recorded, not fixed here): a promote between
`entryPath()` and `goto` in the page.route-based entry-load tests, or during
"an entry that never loads stops after three bounded reloads". The flakiness
review also put the residual risk of a promote landing between a document's
HTML and one of its asset fetches at about 0.1–0.3% per document. Those are alias entry switches, not
version reloads; removing them needs the stale-document tests pinned to an
immutable deployment URL.

10k-agent behavior: test-only; no runtime path changes.

## Human feedback

None recorded.

## Reusable lesson

When a production Playwright step that counts documents or navigates breaks right after another merge goes live, look for `[AppVersion] ... replaced by ... (load); reloading`. Attribute that one-shot reload through the app's own `rose:version-reload:` guard write rather than by request order, and keep deterministic fixture pages off live `/version.json`.
