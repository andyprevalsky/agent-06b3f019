---
id: 2026-10-27-boot-time-migrations-failed-only-on-production-data
date: 2026-10-27
title: Boot-time migrations passed every gate and failed only on production data, blocking all deploys
surface: back-end
component: prisma-migrations
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "/deploy validated migrations only against local and CI databases (prisma db push / migrate on seeded fixtures), never against production's own rows or row counts, while Render runs `prisma migrate deploy` at start so one failing migration blocks every deploy"
symptoms:
  - "2026-10-02: 20260929120000_agent_trajectory_search INSERT ... SELECT over every Message hit statement timeout 57014 (P3018); the failed _prisma_migrations row then blocked every deploy (P3009)"
  - "2026-10-26 22:06–22:17Z: 20261026160004 VALIDATE CONSTRAINT MessageRecord_userId_not_null failed on 4 orphan MessageRecord rows (personId with no Person); Render update_failed, all deploys blocked"
  - "2026-10-26 (S10 deploy): 20261026210002 still carried a whole-table INSERT ... SELECT DISTINCT ON over 2.0M AgentTrajectorySearch rows; caught only by hand"
tags:
  - prisma
  - migrations
  - deploy
  - render
  - production-data
  - statement-timeout
sources:
  - memory:s7-migration-orphan-rows-blocked-render-20261026
  - commit 7252420c6
  - PR #1586
repro: back-end/src/tests/blackbox/migration-preflight.blackbox.ts
status: fixed
---

## Problem

Render's start command runs `npm run prisma:migrate && npm start`. A migration that fails in production therefore leaves the old build serving. The failed `_prisma_migrations` row then refuses every later deploy until someone resolves it by hand. Twice in October a migration passed every /deploy gate and then failed this way. A third time, the failure was caught by hand while reviewing S10's PR.

- **2026-10-02:** the original `20260929120000_agent_trajectory_search` projected every production message in one `INSERT ... SELECT`, and the statement timeout (57014) killed it.
- **2026-10-26:** `20261026160004` validated `CHECK ("userId" IS NOT NULL)` after a backfill (`UPDATE ... FROM "Person"`) that could not fill 4 rows whose Person no longer existed.

## Diagnosis

Every gate ran migrations against local or CI databases built from `schema.prisma` and a reviewed seed fixture. Those databases have neither production's row counts, which make a statement slow, nor its stray rows, which make a constraint fail. The only data that could expose either was production's, and no gate read it before merge.

Local repro (`back-end/src/tests/blackbox/migration-preflight.blackbox.ts`). Each case builds a scratch database shaped like production at that moment:

- **10-26:** a `Person` table and a `MessageRecord` table with 4 orphan rows. The test runs the five committed S7 migrations unchanged. The preflight reports `[validate MessageRecord_userId_not_null] 4 existing row(s) in "MessageRecord" violate it`. Once the orphans are deleted, the same migrations pass.
- **10-02:** 20,000 `Message` rows plus the original migration text, saved as a fixture from `7252420c6^`. The preflight reports `[whole-table] Seq Scan on "Message" reads ~20,000 rows` with `--max-scan-rows 5000`. The schema-only migration that actually shipped passes on the same data.

Against production itself, the S10 seed migration was flagged: `Seq Scan on "AgentTrajectorySearch" reads ~2,042,924 rows (limit 100,000)`.

## Solution

`back-end/scripts/migration-preflight.ts`, registered as the `migration-preflight` live probe in Step 4p (`scripts/run_deploy_live_probes.py`). It takes the migrations this branch adds, skips any already applied on the target, and checks each statement in order:

- **DML:** `EXPLAIN (FORMAT JSON)` runs without ANALYZE. When a target does not exist yet, the preflight explains the row source instead: the INSERT's SELECT, or an UPDATE/DELETE rewritten as a SELECT. A column added by this deploy is read as NULL. The check fails when any scan reads more than 100,000 rows of an existing table.
- **Constraints:** the preflight counts the rows that VALIDATE, a CHECK, a FOREIGN KEY, SET NOT NULL, UNIQUE or a unique index would reject. For a column this deploy adds, it simulates `NULL` unless a pending backfill `UPDATE ... [FROM ...] WHERE ...` would fill the row. That simulation is what reproduces the 10-26 orphan count.
- **Locks:** it warns on write-blocking index builds, table rewrites, scans under ACCESS EXCLUSIVE, and ALTER TABLE without `SET LOCAL lock_timeout`.
- **Safety:** every query runs in a `READ ONLY` transaction with a statement timeout. A failure prints the statement and the exact query that measured it, then exits 1.
- **Overrides:** a migration accepts a measured risk only through an explicit `-- migration-preflight: allow whole-table|unverified <reason>` line.

At 10,000 agents the preflight adds no runtime cost: it is a pre-merge check. It issues one EXPLAIN per DML statement and one bounded count per constraint, and each count reads the table once in a read-only transaction.

## Human feedback

Andy (via the S13 assignment): build a supported pre-merge check for new migrations, part of /deploy, read-only against prod, with EXPLAIN/cost and row-count guards, violating-row counts and lock-level warnings, failing loudly with the exact offending query, and a regression reproducing both incidents locally.

## Reusable lesson

A migration that runs at service start must be proven against the target's own data before merge. Plan its scans and count the rows its constraints would reject, read-only on production. A fixture-built database cannot contain the rows that break it.
