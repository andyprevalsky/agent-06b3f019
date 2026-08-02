---
id: 2026-07-17-seed-local-synced-only-the-dev-user-so-global-tables-were-empty
date: 2026-07-17
title: seed-local synced only the dev user's rows, so the global Waitlist table was empty and the admin panel rendered nothing
surface: back-end
component: seed-local
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/seed-local.ts — syncs only the dev user's data, never global tables like Waitlist
symptoms:
  - admin-health waitlist panel renders empty locally
  - "GET /api/admin-health/waitlist returns no rows on a seeded local DB"
  - gate status untestable locally because no waitlist rows exist
tags:
  - seed-local
  - fixtures
  - admin-health
  - waitlist
  - local-dev
sources:
  - memory:project_waitlist_invite_subscribe_flow
repro: none-recorded
status: fixed
---

## Problem

The new admin-health waitlist panel (`GET /api/admin-health/waitlist`) rendered
empty against a freshly seeded local database, making the
waitlist → invite → subscribe flow impossible to exercise locally.

## Diagnosis

`back-end/scripts/seed-local.ts` syncs only the **dev user's** data from prod. The
`Waitlist` table is global — its rows do not belong to any one user — so it was
never copied. Any feature reading a global table is therefore invisible locally
even though the seed reports success: the seeding model is per-user, and the
feature's data model is not.

## Solution

Added a `Waitlist` sync step to `seed-local.ts` that copies phone-bearing waitlist
rows plus their matching `User` accounts, so the panel renders real data with
truthful gate status locally. (Prod has only ~8 phone-bearing waitlist rows; 3043
legacy email-only rows are filtered out.) Generalizes to any global/reference table
a new admin or gating feature reads — per-user seeding must be extended explicitly.

## Human feedback

None recorded.

## Reusable lesson

When a new panel renders empty on a seeded local DB, check whether the data lives in
a global table — `seed-local.ts` copies only the dev user's rows, so global tables
need an explicit sync step.
