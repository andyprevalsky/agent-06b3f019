---
id: 2026-07-29-browser-context-structural-test-followed-pre-refactor-file-boundary
date: 2026-07-29
title: Browser-context structural test searched session.ts after profile policy moved to profileBinding.ts
surface: harness
component: browser-context-structural-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser-context-nullability.test.ts — benchmark profile assertions searched only the pre-refactor session.ts boundary
symptoms:
  - Steel provider must support benchmark anon mode for fresh per-agent profiles
  - npm run test:structural fails while BENCHMARK_ANON_STEEL_PROFILE support remains implemented
  - browser-context-nullability.test.ts cannot find benchmarkAnonProfilesByAgent in session.ts
tags:
  - structural-test
  - steel
  - browser-context
  - stale-file-boundary
  - benchmark-profile
sources:
  - commit 36131c535e45cabdb2089348f964cabf7070d6a5
repro: back-end/src/tests/structural/browser-context-nullability.test.ts
status: fixed
---

## Problem

The full structural suite failed with `Steel provider must support benchmark
anon mode for fresh per-agent profiles`. The provider still supported
`BENCHMARK_ANON_STEEL_PROFILE`, kept per-agent profiles, and prevented those
profiles from overwriting `BrowserContext.contextId`; those invariants no longer
lived entirely in `session.ts`.

## Diagnosis

Commit `36131c535e45cabdb2089348f964cabf7070d6a5` extracted Steel profile policy
from `session.ts` into `profileBinding.ts`. The structural test continued
searching only `session.ts` for the environment flag and per-agent map, so a
valid implementation refactor appeared to be a product regression. The first
bad boundary was the test's stale ownership model, not the runtime provider.

## Solution

Make each structural assertion inspect the file that owns its invariant:
`profileBinding.ts` for benchmark mode, per-agent state, and persistence policy;
`session.ts` for applying that policy before writing the browser context. Remove
the file-wide lint suppression while touching the test.

## Human feedback

None recorded.

## Reusable lesson

When production policy moves behind a module boundary, update structural guards
to verify the owning module and its call site instead of grepping the old
monolith.
