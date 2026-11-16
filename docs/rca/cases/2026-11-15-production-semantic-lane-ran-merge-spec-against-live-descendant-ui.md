---
id: 2026-11-15-production-semantic-lane-ran-merge-spec-against-live-descendant-ui
date: 2026-11-15
title: The production semantic lane ran the merge's specs against a live frontend that already served a descendant which had intentionally changed the asserted UI
surface: infra
component: deploy-production-semantic-lane
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run_deploy_pipeline.py production_semantic dispatched chat-lifecycle-ratchet.yml with source_sha=<merged SHA> and never consulted the commit the live frontend served, so the checked-out specs (5156d47533) were older than the live UI build (5bf22d752b or newer)
symptoms:
  - "Locator: getByRole('region', { name: 'Integration team sharing' }) Expected: visible Error: element(s) not found"
  - "at front-end/tests-e2e/teams-flow.spec.ts:321:30"
  - "Semantic frontend flows: tests-e2e/teams-flow.spec.ts:21:3 Teams create, invite, opt-in and revoke at 1280px (API fixture)"
  - "production-semantic exited 1 (run 43681354141)"
  - 59 passed, 1 failed; the 4 latency-ratchet jobs passed
tags:
  - semantic
  - production-semantic
  - spec-live-skew
  - verified-by-descendant
  - vercel
  - version-json
sources:
  - PR #2133
  - commit 5156d47533189165683c09c4e89e54ced8dc4740
  - PR #2097
  - commit 7bc451659c
  - fleet run 43681354141
  - PR #2206
  - commit 96c6c1ad04d5c7b4a3b9b23f6ae23425caade656
  - PR #2230
  - fleet run 43690277150
  - fleet run 43690260324
repro: scripts/tests/run-deploy-pipeline.test.py check_production_semantic case 16 (red before the fix, green after); end to end, /var/tmp/semskew/bin/repro.sh runs the real production-semantic code for 5156d47533 against the real live /version.json and then that source's teams-flow spec against https://www.roselabs.ai (Playwright exit 1 before, 0 after)
status: fixed
---

## Problem

`scripts/deploy production --lanes semantic` for PR #2133's merge 5156d47533 dispatched `chat-lifecycle-ratchet.yml` with
`source_sha=5156d47533` at 2026-11-15T05:30:20Z. Run 43681354141, job "Semantic frontend flows": 59 passed and 1 failed.
teams-flow at 1280px could not find the region `Integration team sharing` (`teams-flow.spec.ts:321:30`). The 4
latency-ratchet jobs passed. PR #2133 changed only `agents/` and a docs/rca case. The teams spec uses an in-memory API
fixture, so its only production input is the live frontend.

Vercel had already served descendant 5bf22d752b since 05:24:35Z. That descendant includes PR #2097, which removed the
region and updated the spec in 7bc451659c (`toHaveCount(0)` plus the "Share owner@roselabs.ai with teams" dialog).
Runs 43681397151, 43681488266 and 43681491827 used the newer spec against the same live frontend and passed 60/60.

## Diagnosis

The critical path runs: merge SHA → `production_semantic` dispatch `source_sha` → workflow checkout (specs) → Playwright
against `FRONTEND_URL` → the browser loads the live Vercel build. It goes wrong at the dispatch.
`production_semantic` always sent `source_sha=<merged SHA>`, while the browser loads whatever build Vercel currently
serves. Main merges every few minutes, and each production build publishes `/version.json` as `<12-hex commit>-<time>`
(`front-end/vite.config.ts` `productionBuildId`). On this busy main, the live build is usually a strict descendant of the
merge being verified. Whenever a descendant intentionally changes UI that the merge's spec asserts, the merge's check
fails against correct production UI. `--retry-failed-once` cannot help, because the rerun uses the same skewed spec.

Local repro: the 5156d47533 `front-end` tree, run against live www.roselabs.ai, fails with the identical locator error
at 321:30. The live build's own spec passes against the same frontend.

An independent verifier reached the same first bad boundary without seeing this diagnosis. It also caught a
regression in a first draft of the fix, which refused every ancestor build. Vercel takes about 5 minutes to promote a
build, so for a merge that changes no frontend files, the dispatch usually finds the parent build still live. The
source-equivalent and bounded-wait branches below resolve that.

Why was this possible? The Render, Vercel, Fly and Mac lanes already accept a successful live rollout of a strict
descendant (`PASS-verified-by-descendant`). The semantic lane exercises that same live rollout, but it bound its specs
to the merge alone. It had no notion of which UI build it was testing.

## Solution

Before a fresh dispatch, `production_semantic` reads `<frontend_url>/version.json` (`semantic_source_binding`) and
resolves the build's commit prefix to a full SHA (one `git fetch origin main` if it is unknown here):

- The merge's own build gives `binding.kind=exact` and dispatches the merge, as before.
- A strict descendant (`git merge-base --is-ancestor`) gives `verified-by-descendant` and dispatches the live commit.
  That commit contains the merge, and its specs describe the UI that is live.
- An ancestor build with no change under `front-end/` gives `source-equivalent` and dispatches the merge. This is the
  merge whose build Vercel has not promoted yet, the same idea as the Render lane's `live-ancestor-same-backend`.
- An ancestor whose `front-end/` differs is re-read every 10 s, up to `--live-timeout` (default 900 s, the Vercel lane's
  90×10 s), then refused with exit 1.
- An unrelated build refuses with exit 1.
- An unreadable version, a build id that names no commit, or a commit that cannot be resolved is a tooling error
  (exit 2) and dispatches nothing.

The run is still bound by its title to the exact dispatched commit. A resumed dispatch keeps its recorded binding.
`deploy_prod.lane_semantic` reports a descendant binding as `PASS-verified-by-descendant`, never as an exact PASS. No
spec, assertion, timeout or concurrency changed.

Siblings prevented: every semantic spec (UI flows and the chat lifecycle ratchet) that a live descendant intentionally
changed. Not covered, and owned elsewhere: a build promoted while the run is already executing (the related threads
for that class).

Shipped in PR #2206 (merged 96c6c1ad04, 2026-11-15). Production proof:

- **The original failing command.** `scripts/deploy production --sha 5156d47533 --lanes semantic` was rerun against the
  originating deploy's restored state dir (PR #2133 closeout private archive). It printed `DEPLOY_PRODUCTION PASS
  lanes=fly:PASS,workflow-migration:PASS,semantic:PASS-verified-by-descendant`. Run 43690277150 bound live descendant
  31641a670910, and in it `teams-flow.spec.ts:21:3 ... at 1280px (API fixture)` passed, 60 of 60.
- **#2206's own merge.** It first bound `source-equivalent`, because its build was not yet promoted. That dispatch hit a
  REST quota 403. Rerun after the reset, run 43690260324 passed as PASS-verified-by-descendant.

Those two verifications ran concurrently and both bound the same live commit, so their run titles were identical. The
watcher adopts the newest matching title after its own dispatch, so a slower poll would have adopted the other
dispatch's run. PR #2230 closes this: every dispatch sends a `dispatch_id` that the workflow's run-name echoes, and the
watcher requires it (merged c77b537709, 2026-11-16).

## Human feedback

None recorded.

## Reusable lesson

Bind a production check's test revision to the build that production actually serves, and accept a live strict descendant as verified-by-descendant, as the rollout lanes do.
