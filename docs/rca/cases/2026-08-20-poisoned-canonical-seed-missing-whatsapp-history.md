---
id: 2026-08-20-poisoned-canonical-seed-missing-whatsapp-history
date: 2026-08-20
title: Canonical whatsapp-v2 R2 seed dump restored without reviewed rows (WhatsApp history; later archived agent trajectories)
surface: harness
component: seed-dump-cache / run.sh restore
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: shared R2 object benchmark-seed-dumps/<schema>-pg<major>-victoria-prod-sync-v1-whatsapp-v2.dump — published without reviewed rows the revision promises; the canonical content check did not cover them (WhatsApp 2026-08-20; AgentTrajectorySearch archive rows on every pg15 publication through 2026-10-19)
symptoms:
  - "Source(s) not connected: whatsapp"
  - grep messages → 0 matches after seed restore
  - whatsapp-history-recall Timeout after 301s (ACTIVE, expected COMPLETED)
  - "grep: 'example\\.com' -> 0/0 matches in agent_trajectories"
  - "Declared evaluator prior-browser-and-code-facts failed"
tags:
  - seed-dump
  - canonical-base
  - whatsapp
  - fixtures
  - whatsapp-history-recall
  - agent-trajectories
  - grep-agent-trajectories-cross-surface
  - pg15
sources:
  - PR #1299
  - fleet run 20260820_211517_whatsapp-history-recall
  - agent 76b73506-a102-4ebc-a623-c69f5c279206
  - memory:poisoned-canonical-whatsapp-v2-seed-r2-cc104a3f
  - memory:prior-good-whatsapp-v2-seed-r2-2667c51
  - benchmark run original600-1792433794419199295 (2026-10-19 sharded cloud, 9/9 grep-agent-trajectories-cross-surface FAILED)
  - agent 0863942f-e6b9-4a12-8abd-6ee873b48894
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

## Recurrence 2026-10-19: pg15 artifacts without archived agent trajectories

**Symptom.** In cloud sharded run `original600-1792433794419199295` (source
f9c01f05c), 9/9 `grep-agent-trajectories-cross-surface` jobs failed. Eight
failed `prior-browser-and-code-facts` and one hit the 300s backstop. The guest
backend logged `grep: 'example\.com' -> 0/0 matches in agent_trajectories` for
agent `0863942f-…`, with no filters. The agent then spawned new browser and
coding agents, and the judge rejected them as not prior-run evidence.

**Evidence.** The guest `stack.log` shows the restore of
`cf8b2471…-pg15-victoria-prod-sync-v1-whatsapp-v2` and `canonical seed dump ok`
(WhatsApp only). Between restore and the grep, nothing deleted trajectory rows.
`AgentTrajectorySearch deleteMany` appears only after the grep, from archive
finalization. A per-table diff of that pg15 object against its pg16 sibling
`cf8b2471…-pg16-…` found exactly one difference: `AgentTrajectorySearch` had 0
rows vs 241. The 241 rows are archive-backed rows for three prior runs: browser
`ec19feb9` (42), Collatz `c4531f8e` (21) and city comparison `18ad8b43` (178).
The catalog tasks name this content: "historical R2 trace content materialized
in the canonical base image search index". The pg15 objects for schema hashes
`fc9dc500` (2026-10-03), `82fe660b` (10-06), `50ee010b` (10-07) and `cf8b2471`
(10-19) all had 0 rows; each pg16 sibling had them. The pg15 lineage never
carried the rows after the 2026-09-29 trajectory migration. Each pg15
publication migrated the previous pg15 fixture, so the new table was created
empty, as noted in the PR #1299 schema-only refresh above. Fresh volumes did
not drop the rows; cloud guests never had them. Running the backend's
`searchTrajectorySource` against a local restore of the pg16 object returned 9
matches for the identical grep.

**Why the 2026-08-20 fix did not hold.** That fix encoded one promised row set
(WhatsApp) in `validate-canonical-seed-dump.sh`. The revision's content promise
grew when the trajectory tasks declared archived traces in the same base image,
but the validator was not extended. The PG15 publication workflow and every
guest restore therefore validated an incomplete fixture as canonical.

**Fix.**
1. Infra repair, 2026-10-19 19:41Z: restored the original pg15 object into an
   isolated `pgvector/pgvector:pg15` container and loaded the 241 rows from the
   pg16 sibling (identical table fingerprint across majors). All 75 public tables
   were fingerprinted: only `AgentTrajectorySearch` changed. The dump came from
   the PG15.19 client (archive 1.14, TOC identical to the original), passed a
   round-trip restore with identical fingerprints and the extended validator,
   and was republished under the same key. Readback sha256 is `f3e451e2…`; the
   original pg15 object sha256 is `154e8b01…`. Both are retained in
   `/project/pr1525-evidence/grep-traj-fresh-volume/`.
2. `scripts/validate-canonical-seed-dump.sh` now also requires, for the bench
   user, archive-backed `AgentTrajectorySearch` rows for each of the three
   reviewed roots at their reviewed counts. Live rows written by the restored
   stack never count. `run.sh` messages now name both row sets.
3. Under the same key, a correction does not reach volumes that already hold
   the old bytes. `seed_cache_decision` reuses any local copy whose sidecars
   match and never contacts R2. In `run.sh`, a reused copy that fails the
   content check now re-pulls the shared object once before failing closed. A
   freshly pulled failure stays final.
4. Regressions:
   - `scripts/tests/canonical-seed-whatsapp-content.test.sh` builds a fixture in
     a throwaway `initdb` cluster on a private unix socket. With WhatsApp rows
     only, the old validator exited 0 where 1 was expected in three cases. All
     pass after the fix, and the real pg15/pg16 restores give 1 and 0
     respectively.
   - `scripts/tests/seed-cache-decision.test.sh` runs the real `run.sh` consumer
     section with a fake R2, restore and validator. It covers three cases: a
     stale reused copy, a freshly pulled bad copy, and both bad. On the base two
     cases failed; on the fix all pass.
   - Both suites passed 5 consecutive runs and are deploy structural gates.
5. Local outcome check: `scripts/run-bench --local
   grep-agent-trajectories-cross-surface` with a `pg_dump --version` shim
   reporting 15. The shim reproduces the guest's key selection and content only:
   `pg_restore` and the server stayed at PG16.
   - Base revision with the old object: FAIL (agent `63f7bd7b…`). Every
     `agent_trajectories`-only grep returned 0/0. The earlier 3/3 hits came from
     the combined `agent_trajectories,agent_network` source.
   - Fix with the republished object: PASS (agent `6601049e…`),
     `'example\.com' -> 9/9 matches in agent_trajectories`.
   - The cloud outcome is pending an exact cloud member rerun.

**Open.** No publish-time check compares per-table fingerprints across the PG
majors of one schema hash. Each major is still produced by its own procedure,
and the pg15 lineage migrates the previous pg15 fixture. The validator now
blocks this content gap, but not some future divergence in a row set it does
not name.

**Golden reference.** I searched `claude-code-src/`, `openclaw/`,
`hermes-agent/` and `codex/` for seed-dump, `pg_restore` and fixture-validation
analogs. None of them publishes benchmark database fixtures, so no reference
applies.

## Human feedback

Pending HARNESS_FIX_DECISION for whatsapp-history-recall outcome-proof rerun.

## Reusable lesson

A cache key's *revision name* is a content promise, not a size promise: gate
restore and publish on every reviewed row set that catalog tasks declare in the
base image, and extend that gate whenever a task adds base-image content.

## Schema-only refresh during PR #1299

After merging main's reviewed PlannerMemory migration, cloud preflight correctly
refused the missing `105b336b6195266377feff58cbf93abc818e0bc4-pg15-...` key.
The prior `68c247627227166f0dd7a91003a68efd227aac5a-pg15-...` canonical fixture
was restored into an isolated PostgreSQL 15 container and the checked-in SQL
migration was applied. Fingerprints preserved every row in all 68 existing
tables (excluding only the newly added Agent.memoryEnabled column); the sole
new table was empty and the new column had its reviewed default.

Prisma reported no schema difference. The canonical validator verified all
3,825 WhatsApp messages and the connected integration before and after a PG15
dump/restore round trip. The newly keyed artifact was published only after
confirming absence, then downloaded and compared byte-for-byte. The isolated
container and anonymous volume were removed. Evidence is retained under
`.context/acceptance/canonical-pg15/`; no cold-sync or coverage rows were used.
