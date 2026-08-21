---
id: 2026-08-20-poisoned-canonical-seed-missing-whatsapp-history
date: 2026-08-20
title: Canonical whatsapp-v2 R2 seed dump restored 0 WHATSAPP MessageRecords
surface: harness
component: seed-dump-cache / run.sh restore
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: shared R2 object benchmark-seed-dumps/<schema>-pg16-victoria-prod-sync-v1-whatsapp-v2.dump — published without reviewed WhatsApp rows; run.sh restored it with no content check
symptoms:
  - "Source(s) not connected: whatsapp"
  - "No local data available."
  - grep messages → 0 matches after seed restore
  - whatsapp-history-recall Timeout after 301s (ACTIVE, expected COMPLETED)
  - User context fetched messages=0 contacts=0
tags:
  - seed-dump
  - canonical-base
  - whatsapp
  - fixtures
  - whatsapp-history-recall
sources:
  - agent 76b73506-a102-4ebc-a623-c69f5c279206
  - fleet run 20260820_211517_whatsapp-history-recall
  - memory:poisoned-canonical-whatsapp-v2-seed-r2-cc104a3f
  - memory:prior-good-whatsapp-v2-seed-r2-2667c51
repro: bash scripts/tests/canonical-seed-whatsapp-content.test.sh
status: fixed
---

## Problem

Local `scripts/run-bench --local whatsapp-history-recall` restored the shared
canonical seed dump, then the explore agent reported WhatsApp as not connected
and found zero messages. The root agent fell back to a browser session on
web.whatsapp.com and timed out at the 300s cap still ACTIVE.

## Diagnosis

Archive searches (`Source(s) not connected: whatsapp`, `No local data available`,
`whatsapp-history-recall`, `seed dump empty MessageRecord`) found relatives
(seed-cache staleness, UTC-day rollover, PG18 archive headers) but no identical
case for a whatsapp-v2 revision object that restores with **zero** WHATSAPP rows.
Novel relative of the fixture-poison class.

Critical path: R2 `seed-dump-cache get` → `run.sh` pg_restore → agent grep
`source_status(whatsapp)` / `MessageRecord` reads.

Binary search:

1. Task contract promises 3825 WHATSAPP rows + CONNECTED whatsapp Integration on
   `base:victoria-prod-sync-v1` (revision `victoria-prod-sync-v1-whatsapp-v2`).
2. Worker log: `messages: 0, contacts: 0` immediately after init.
3. Restoring the pulled local dump into `victoria_rca_probe` measured
   `MessageRecord` count **0** and no CONNECTED whatsapp Integration for
   `1f85ff25-…`.
4. R2 still held the reviewed Aug-5 artifact under an older schema token
   (`2667c51…-pg16-…whatsapp-v2`, 152MB text) with **3825** WHATSAPP rows and
   CONNECTED whatsapp for that user. Current schema token
   `cc104a3f…-pg16-…whatsapp-v2` had been overwritten on 2026-08-11 with a
   cold-sync-shaped dump lacking WhatsApp history.
5. Size cannot gate this: a custom-format (`-Fc`) dump of the *good* fixture is
   also ~31MiB. Only a post-restore row-content check distinguishes them.

First-bad boundary: accepting/publishing a whatsapp-v2 cache object without
verifying the reviewed WhatsApp row set after restore.

## Solution

1. Migrated the reviewed Aug-5 dump onto the current schema, republished it under
   the current `cc104a3f…-pg16-victoria-prod-sync-v1-whatsapp-v2` token, and
   replaced the local seed-cache copy.
2. Added `scripts/validate-canonical-seed-dump.sh` (requires ≥3825 WHATSAPP
   MessageRecords + CONNECTED whatsapp Integration for the bench user).
3. Wired the validator into `scripts/run.sh` after restore (fail closed when
   `BENCHMARK_REQUIRE_SEED_DUMP=1`) and before R2 publish.
4. Cemented via `scripts/tests/canonical-seed-whatsapp-content.test.sh` (RED on
   poisoned probe, GREEN on fixed probe) and registered it in
   `scripts/test.sh` + deploy structural gates.

## Human feedback

Pending HARNESS_FIX_DECISION for whatsapp-history-recall outcome-proof rerun.

## Reusable lesson

A cache key's *revision name* is a content promise, not a size promise. When two
valid archive encodings of different row sets share the same byte-size band,
gate restore and publish on the reviewed row invariants — never on file size
alone.
