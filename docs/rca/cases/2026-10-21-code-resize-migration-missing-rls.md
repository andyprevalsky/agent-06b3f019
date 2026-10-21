---
id: 2026-10-21-code-resize-migration-missing-rls
date: 2026-10-21
title: Code session resize migration omitted required row-level security
surface: back-end
component: prisma-migrations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: CodeSessionResize CREATE TABLE migration omitted ENABLE ROW LEVEL SECURITY
symptoms:
  - a client role must not read another user's resize
  - CodeSessionResize relrowsecurity false
sources:
  - commit b33df30d3828452b776de09d8c0a07171a73484e
  - plan:/tmp/resize-rls-registered-before.log
tags:
  - postgres
  - rls
  - migration
  - code-session-resize
repro: back-end/src/tests/blackbox/code-session-resize.blackbox.ts resize migration keeps bookkeeping private from client roles
status: fixed
---

## Problem

While reviewing the eleven pending migration files before deployment, the
resize bookkeeping table lacked the RLS enablement required for every table
by CLAUDE.md. This was a source migration defect; no production exposure was
observed or asserted. In a local transaction, replaying the actual migration
and granting a fresh non-bypass client role SELECT exposed the seeded record:
the registered regression failed with actual count 1, expected 0.

## Diagnosis

DDL creation -> CodeSessionResize -> default RLS disabled -> ordinary SELECT
grant permits reading all records. Prisma db push and owner-level API tests do
not verify this boundary. Archive searches for RLS migration enablement and the
literal table/relrowsecurity failure found no exact prior case. No automatic
RLS DDL event trigger exists in the repository migrations or inspected private
database. Other new tables in this branch enable RLS explicitly.

Golden reference: the adjacent LocalDevice migration enables RLS without
client policies for backend-only storage. External coding harnesses have no
analog for Rose's multi-user Postgres API bookkeeping. An independent
adversarial review confirmed the missing boundary and required genuine
NOSUPERUSER NOBYPASSRLS role checks rather than a flag-only assertion.

## Solution

Enable RLS in the pending resize table creation migration without adding
client policies, matching the existing backend-only table pattern. The
unchanged regression now sees zero records as the client and one as database
owner, checks RLS is enabled and policies absent, and rolls all scratch DDL and
role changes back on failure. Unique scratch schemas and roles avoid touching
existing policies or roles. It runs only against loopback Postgres.

Command (from the private backend checkout):
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria_rose_ui_sem
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria_rose_ui_sem
npx tsx --test --test-name-pattern='resize migration keeps bookkeeping private'
src/tests/blackbox/code-session-resize.blackbox.ts

Before: one client-visible row and assertion failure, 1.51s total.
After: zero client-visible rows and PASS, 1.01s total.
The canonical runner discovers and passes the entire code-session-resize
domain in 3.048s against an owned temporary backend on port3911. Logs:
/tmp/resize-rls-registered-before.log, /tmp/resize-rls-registered-after.log,
/tmp/resize-rls-owning-suite.log. This source amendment belongs to the pending
branch migration; an already-applied installation would require a new forward
migration rather than assuming an edited history is replayed.

## Human feedback

Keep work limited to original acceptance criteria and critical deployment
blockers. No user requested a client-access policy or change to permissions.

## Reusable lesson

Exercise new migration DDL as an ordinary client role. Owner-level API tests
and Prisma schema synchronization cannot prove row-level security isolation.
