---
id: 2026-11-15-semantic-folder-controls-reload-step-raced-app-version-reload
date: 2026-11-15
title: Folder-controls reload step raced the app's one-shot reload onto a deploy promoted mid-run
surface: front-end
component: tests-e2e-project-folder-controls
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e/project-folder-controls.spec.ts reload step (page.reload → openSidebar → expect.poll(order) at :186-188) assumed the reloaded document survives, while src/lib/appVersion.ts reloads it once on load when /version.json names a newer build
symptoms:
  - "Error: locator.evaluateAll: Execution context was destroyed, most likely because of a navigation"
  - "at front-end/tests-e2e/project-folder-controls.spec.ts:188:5"
  - "folder ordering, icon counts and project collapse at 390px"
  - "[AppVersion] build 6b7f1b4023a3-mwheugs1 replaced by 384f98c334c8-mwheuusc (load); reloading"
  - "folder order not restored after reload"
tags:
  - semantic-gate
  - production-semantic
  - app-version-reload
  - deploy-switch
  - playwright
  - flaky-e2e
  - recurrence
sources:
  - PR #2158
  - commit 6e2977bc0c690cdfc90380e8fea391a123a22fb3
  - commit ab6c05dbbb
  - PR #1657
repro: front-end/tests-e2e/project-folder-controls.spec.ts
status: fixed
---

## Problem

The production semantic gate for merge 6e2977bc0c (PR #2158, back-end AgentCard
files only) failed one test in job "Semantic frontend flows" (run 43682337505,
job 132715452440): `project-folder-controls.spec.ts:6` at 390px threw
`locator.evaluateAll: Execution context was destroyed, most likely because of a
navigation` from `order()` (:171) inside `await expect.poll(order).toEqual(saved)`
(:188). That poll runs right after `page.reload()` and `openSidebar()`. The same
test passed in run 43682339848, started 2 s later, and in four other runs that
morning. PR #1657's production gate once failed this same step ("folder order not
restored after reload").

The failure trace (artifact semantic-frontend-43682337505, `trace.zip`) shows:
`reload` at t=51414 ms, the "Open menu" click at 52089, mocked `/api/agents` and
`/api/projects` served at 52166–52293. Then at 52344 the console logged
`[AppVersion] build 6b7f1b4023a3-mwheugs1 replaced by 384f98c334c8-mwheuusc (load); reloading`.
The poll's `evalOnSelectorAll` began at 52353 and died with the navigation. The
page snapshot shows the reloaded app with its menu closed.

## Diagnosis

1. `src/lib/appVersion.ts` checks `/version.json` on every document `load` and
   reloads the page once per tab session onto a newer build. This is intended
   production behavior.
2. Every main push promotes a new Vercel build (see case
   2026-11-11-semantic-helper-evaluate-raced-app-version-reload). Here a build
   promoted between the test's first `goto` (old build, no reload) and its
   `page.reload()`. The reloaded document still came from the old build, but its
   load check saw the newer id about 0.9 s later, on the busy runner, right as the
   order poll ran.
3. The spec assumed the document from `page.reload()` survives its later steps.
   The 2026-11-11 case had listed `project-folder-controls` among the at-risk
   sites; it was not fixed then. So this is a **recurrence** of that case's class
   at a known, unfixed site.
4. Why was that possible? `acrossAppReload` (the fix from 2026-11-11) only retries
   a step that *throws*. A step can also succeed on a document the app replaces a
   moment later, and nothing let a test tell a page whose version check has
   settled from one about to reload. The pre-fix spec under the deterministic
   simulation below shows this: the poll passes on the dying document, then
   `Expand Home` visible (:225) fails on the reloaded one, 5/5.

Local repro (production `vite build` served by `vite preview`, all `/api` mocked by
the spec, no backend). `/var/tmp/pfc390/scripts/repro.sh` rewrites
`dist/version.json` to a newer id once the spec writes its :146 screenshot (just
before the reload step). A proxy holds the promoted `/version.json` 400 ms,
matching the CI timing. Command:
`FRONTEND_URL=http://127.0.0.1:4318 npx playwright test tests-e2e/project-folder-controls.spec.ts -g 390px`.
- Unchanged spec: failed 3/6 with the identical error at
  `project-folder-controls.spec.ts:188:5`.
- Control (no promotion): passed.
- Fixed spec: 28/28 passed under the identical command (20 before, 8 after the
  pre-attribute bundle change below).

## Solution

Commit ab6c05dbbb:

- `src/lib/appVersion.ts` publishes its state-machine state on
  `<html data-version-check>`: `checking`, `idle`, `pending`, or `reloading`
  (`reloading` is sticky). An e2e step can now observe that the document's check
  settled without a reload. There is no runtime behavior change; it is covered by
  `app-version.blackbox.ts`.
- `tests-e2e/helpers.ts`:
  - New `expectAppVersionSettled` waits for that state and throws while it reads
    `reloading`.
  - `acrossAppReload` now also repeats a step that succeeded on a document the
    app then replaced.
  - It no longer counts redirect hops of the step's own navigation as new
    documents.
  - `app-reload-helper.spec.ts` gains both cases. Each fails without its change:
    the success-retry test against the old helper, and the redirect test with the
    filter removed.
- `project-folder-controls.spec.ts`:
  - Its `goto` and `reload` steps run as one `acrossAppReload` step: navigate,
    open the sidebar, wait for the group, then `expectAppVersionSettled`.
  - On production builds it simulates this run's deploy. From its reload on,
    `/version.json` names `<served>-promoted`. The first promoted answer is held
    until the reloaded sidebar is open (the CI timing).
  - It asserts the app really logged the reload.
  - A bundle older than this change (a rollback, or a run against an older
    deployment) never publishes `data-version-check`. There,
    `expectAppVersionSettled` returns false and the spec does not simulate,
    because the simulation would just replay the race. Verified against a
    bundle built from the pre-fix `appVersion.ts`: passes at both widths.
  - No assertions or timeouts were weakened.
  - The pre-fix navigation with this simulation fails 5/5.
  - The fixed spec passes 5/5 consecutive runs at both widths, and 20/20 at 390px
    under the external repro.

The new helper lets the other sites listed in the 2026-11-11 case wait the same
way. Those sites are other specs and are not changed here.

Independent verification: a fresh reviewer, given only the symptom and the
trace, named the same first bad boundary. Its trace reading:
- the first `/version.json` was a CDN HIT for 6b7f;
- the test's reload got edge-cached old HTML (HIT, age 19 s);
- the reloaded page's `/version.json` was a MISS returning 384f, newly promoted;
- the reload landed 9 ms before the poll.

It also raised the pre-attribute-bundle case (fixed above). Not fixed here,
recorded as follow-up:
- **Gate target.** The production semantic gate targets the mutable
  `www.roselabs.ai`, not the immutable Vercel deployment of the verified SHA.
  Running it against the deployment URL would remove this class of race for
  every spec, at the cost of a deploy-gate wiring change.
- **Other sites.** The other specs listed in the 2026-11-11 case remain
  unprotected until they adopt `expectAppVersionSettled`.

Coverage note: `scripts/select_affected_tests.py --lanes-for` reports every
`tests-e2e` spec as "NOT RUN", including the 2026-11-11 regression. It models no
semantic lane. The spec does run in the deploy semantic stack lane
(`run-deploy-semantic-stack.sh` → `run-semantic-tests.sh`, which globs
`tests-e2e/*.spec.ts`) and in the production semantic gate, where this failure
occurred. 10k-agent behavior: one DOM attribute write per version check per tab;
no server or per-agent work.

## Human feedback

None recorded.

## Reusable lesson

A production-facing Playwright step after any `goto`/`reload` must end on a settled document: wait for `<html data-version-check>` to leave `checking` (`expectAppVersionSettled`) inside `acrossAppReload`, because a promoted deploy reloads the app once, possibly after the step's own assertions already passed.
