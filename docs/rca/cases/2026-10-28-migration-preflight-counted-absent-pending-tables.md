---
id: 2026-10-28-migration-preflight-counted-absent-pending-tables
date: 2026-10-28
title: Migration preflight counted foreign keys against tables not yet created
surface: back-end
component: migration-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Foreign-key validation bypassed pending-table state before querying the read-only target
symptoms:
  - Three orphan-count queries failed with PostgreSQL 42P01
  - Pending ProjectCliLogin and ProjectMaintenanceRun migrations failed preflight
tags:
  - migrations
  - preflight
  - pending-tables
sources:
  - PR #1634
repro: back-end/src/tests/blackbox/migration-preflight.blackbox.ts
status: fixed
---

## Problem

The read-only production preflight knew that pending migrations create two new
empty tables, but its foreign-key checks queried those absent relations anyway.

## Diagnosis

The unchanged pending migration files reproduced all three 42P01 errors against
an isolated local database. Existing unique checks handled pending tables
separately and could also incorrectly assume emptiness after pending writes.
Archive searches for orphan counts and pending tables led to the earlier
production-data preflight case; this was a distinct defect in the checker.

## Solution

Classify pending tables at a shared constraint boundary. A table is safely empty
only when it is newly created, absent on the target, and has no pending population.
INSERT, WITH, COPY, MERGE, procedural statements and CREATE TABLE AS invalidate
that proof. Unsupported future contents fail closed. CREATE TABLE IF NOT EXISTS
against an existing relation still checks its real rows. No migration SQL,
threshold, or production data changed.

## Evidence

The identical registered blackbox command failed before and passed afterward:
`node_modules/.bin/tsx back-end/src/tests/blackbox/migration-preflight.blackbox.ts`
with DATABASE_URL and DIRECT_URL pointing to local Postgres. It creates and drops
only its own scratch databases. Four regression groups cover the actual pending
migrations, populated-table rejection, existing-table orphans, and the original
backfill and scan controls. Logs: `/var/tmp/preflight-rca-before.log` and
`/var/tmp/preflight-rca-after.log` on the investigation machine.

The normal production read-only preflight then passed all three pending
migrations. Existing lock-timeout warnings remain visible. Receipt:
`/var/tmp/rose-final-migration-preflight-fixed.log`. This check applies no DDL.

## Human feedback

The user requested that all fixes be included in PR1634 and deployment be completed. No case-specific waiver of migration validation was given.

## Reusable lesson

Absence on the current database does not by itself prove a future table empty.
Use one pending-state classification for every constraint query and reject
unmodeled future writes rather than silently accepting them.
