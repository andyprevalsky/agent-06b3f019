---
id: 2026-07-19-stale-baked-seed-dump-blocked-the-remote-cache-consult
date: 2026-07-19
title: A schema-stale seed dump baked into the warm image made the R2 seed cache dead code, so every clone cold-synced for ~13 minutes
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: 'scripts/run.sh seed guard — `[ ! -s "$_SEED_DUMP" ]` consulted the R2 cache only when NO local dump existed, never when the local dump was schema-stale'
symptoms:
  - every freshly-cloned bench box cold-syncs the prod DB (~13 min boot)
  - R2 seed-cache download never happens even though a matching dump exists
  - restore fails its schema-hash check and falls back to cold sync
  - only the box that wins the cold-sync race reaches the start barrier (0/8, 1/8)
tags:
  - cloudbench
  - benchmark-seed
  - r2-cache
  - warm-image
  - schema-hash
sources:
  - commit 89969bda6
  - memory:project_ecommerce_slice_compute_token_gate
repro: scripts/tests/seed-cache-decision.test.sh
status: fixed
---

## Problem

The shared R2 seed-dump cache — built specifically to kill the ~19-minute cold-sync
boot — was DEAD CODE on cloud boxes. The warm snapshot
(`cloudbench-warm-local-20260716`) bakes a `/data/cloudbench-cache/victoria-seed.dump`
whose schema hash had drifted. That stale file both blocked the R2 download AND
failed the restore's hash check, so every clone fell through to a full prod cold
sync (~13 min). At fleet width only the box that won the cold-sync race reached the
synchronized-start barrier, producing 0/8 and then 1/8 runs.

## Diagnosis

The decision "should I consult the remote cache?" was expressed as a file-presence
test (`[ ! -s "$_SEED_DUMP" ]`) rather than a usability test. A _present but
unusable_ artifact therefore read as "already satisfied", which is the worst of the
three states — it suppressed the faster remote path and still could not be
restored. The stale artifact came from baking mutable state into an immutable Fly
snapshot, which cannot be deleted, so the bad input was permanent until the guard
learned to distrust it.

## Solution

Centralised the choice in `scripts/lib/seed-cache.sh:seed_cache_decision()`:
absent OR schema-stale → consult the remote cache. Cemented by
`scripts/tests/seed-cache-decision.test.sh`. The surrounding cache design was
deliberately additive and neighbour-safe: `get` fails closed (exit 1) so `run.sh`
falls back to the existing cold sync, a schema-hash guard plus `pg_restore`
fallback catch corruption, and it never mutates the shared warm box or its
immutable snapshots. The rejected alternative was baking the dump into the warm
snapshot and repointing the shared proven-snapshot fingerprint — too risky for
concurrent fleets.

## Human feedback

None recorded.

## Reusable lesson

Gate a cache consult on whether the local artifact is USABLE (schema/version
match), not on whether the file exists — a stale baked artifact otherwise disables
the fast path and fails the slow one.
