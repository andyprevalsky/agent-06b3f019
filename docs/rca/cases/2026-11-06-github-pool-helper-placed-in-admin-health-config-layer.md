---
id: 2026-11-06-github-pool-helper-placed-in-admin-health-config-layer
date: 2026-11-06
title: The GitHub token pool helper was wired into admin-health's config layer, which may not import providers
surface: back-end
component: admin-health-config-layer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/admin-health/config.ts imported providers/githubTokenPool for githubApiTokenCandidates
symptoms:
  - "LAYER VIOLATION in domains/admin-health/config.ts"
  - "config may not import from providers/"
  - "Results: 2128 passed, 1 failed, 2129 total"
tags:
  - layer-deps
  - structural
  - github-token-pool
  - deploy-quick-gate
sources:
  - PR #1723
  - commit 3892c270fa708b929baa058bc14339050ddbada5
  - task .context/deploy-pipeline/attempts/1/quick/backend-structural/output.log
repro: back-end/src/tests/structural/layer-deps.test.ts
status: fixed
---

## Problem

The first `/deploy` quick phase of PR #1723 (the GitHub token pool) passed format, typescript and eslint but failed `backend-structural` in 3 seconds: `npm run test:structural` stopped in `layer-deps.test.ts` with `Results: 2128 passed, 1 failed, 2129 total` and `LAYER VIOLATION in domains/admin-health/config.ts: config may not import from providers/`.

## Diagnosis

Gate: INTRODUCED. To make admin-health's commit chart read from the pool, this PR rewrote `githubApiTokenCandidates()` in `domains/admin-health/config.ts` to call `githubTokenCandidates('pool')` from `providers/githubTokenPool`. The structural rule table in `layer-deps.test.ts` (`config: ['types']`, `config: { providers: false, utils: false }`) gives the config layer no provider or util imports. TypeScript, eslint and the focused unit tests all passed, so only this structural invariant knew about the layering.

Local repro (pre-fix, commit 3892c270f): `cd back-end && npx tsx src/tests/structural/layer-deps.test.ts` printed the violation and `1 failed`. Post-fix the same command prints `Results: 2129 passed, 0 failed, 2129 total`. The full `npm run test:structural` also exits 0 after the fix.

The deepest owned cause is placement: a function that needs a provider belongs in the repo/service layer. `githubCommits.ts` (the only runtime consumer besides `velocity.ts`) already imports providers.

## Solution

Moved `githubApiTokenCandidates()` from `config.ts` to `githubCommits.ts` (same body, same dispatch-token fallback comment) and pointed `velocity.ts` and the two unit tests at it; `config.ts` no longer imports a provider. The existing `layer-deps` structural test is the registered regression: it runs in the `backend-structural` quick gate of every deploy, and it caught this change in 3 seconds. No new test was needed.

10k agents: the change moves a function between modules; its cost is unchanged (O(pool members) per call, per-process state).

## Human feedback

None recorded.

## Reusable lesson

When a config-layer helper starts needing a provider, move it to the repo or service layer instead of importing the provider into `config.ts`; `layer-deps.test.ts` (backend-structural) will fail otherwise.
