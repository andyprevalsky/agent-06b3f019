---
id: 2026-07-03-run-local-message-refs-hashed-into-the-fast-cache-goal-key
date: 2026-07-03
title: Run-local `@ref:message:<uuid>` pointers were hashed verbatim into the fast-cache goal key
surface: cross
component: fast-cache
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: normalize.py / fastCacheNormalizeCore.ts — goal_hash hashed `@ref:message:<uuid>` without canonicalizing the run-local uuid
symptoms:
  - fast-cache namespace changes every run for a goal containing an attachment reference
  - "7 mis-keyed root rows on run b429f478 ($60)"
  - root-level cache misses while all 50 sub-agent namespaces are stable
tags:
  - fast-cache
  - cache-key
  - normalization
  - cost
  - message-refs
sources:
  - memory:project_fastcache_chat_goal_namespace
repro: none-recorded
status: fixed
---

## Problem

A goal text containing a run-local `@ref:message:<uuid>` pointer produced a
different goal hash on every run, so its fast-cache namespace was never reused.
Concretely, run `b429f478` (a $60 run) had 7 mis-keyed root rows while all 50 of
its sub-agent namespaces were already stable.

## Diagnosis

`goal_hash` / `goalHash` hashed the goal text verbatim. `@ref:message:<uuid>`
pointers are minted per run, so their uuids are pure run-local entropy inside an
otherwise identical goal — every run got a fresh namespace. Sub-agent namespaces
were unaffected because their refs live in status messages rather than in the
stored goal, which is why only the root rows were mis-keyed.

## Solution

Both mirrors — `normalize.py` (Python) and `fastCacheNormalizeCore.ts`
(TypeScript) — now canonicalize `@ref:message:<uuid>` pointers before hashing;
they must be kept in sync. The already-mis-keyed rows from run `b429f478` were
copied into the persisted namespace with
`back-end/scripts/rekey-fastcache-run.ts`, a non-destructive
`INSERT … ON CONFLICT DO NOTHING` against the prod DB (`DATABASE_URL` fetched via
the Render env API). Note on reproducing after the fix: a direct-start rerun (same
prompt, `start_phase: "plan"`) replays even on pre-fix prod code, whereas a
chat/FE rerun needs the workflow fix deployed.

## Human feedback

None recorded.

## Reusable lesson

Strip or canonicalize every run-local identifier (message refs, uuids,
timestamps) before hashing anything into a cache key, and change all language
mirrors of the normalizer together.
