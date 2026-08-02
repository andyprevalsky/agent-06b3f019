---
id: 2026-07-17-prisma-pool-limit-ignored-deploy-overlap-and-the-second-pool
date: 2026-07-17
title: A hand-picked Prisma connection_limit ignored deploy overlap and the fast-cache pool, so every Render deploy 500s prod with pooler EMAXCONN
surface: back-end
component: database-provider
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "back-end/src/providers/database.ts getConnectionUrl() — connection_limit=250 was a fixed constant, unaware of the 2-instance deploy overlap and of the second (fast-cache) Prisma pool"
symptoms:
  - "FATAL: (EMAXCONN) max client connections reached, limit: 400"
  - "intermittent -> 500 plus prisma:error on DB-backed endpoints for ~1-4 min after go-live"
  - "every Prisma op clusters at p90 ≈ 30s (pool-acquisition timeout)"
  - "159 EMAXCONN events in one deploy window, self-clearing once the old instance drains"
tags:
  - prisma
  - supabase
  - supavisor
  - connection-pool
  - deploy-window
sources:
  - PR #787
  - commit e4e846651
  - memory:project_prod_deploy_window_emaxconn
repro: back-end/src/tests/structural/db-pool-invariant.test.ts
status: fixed
---

## Problem

During every Render backend deploy the OLD and NEW instances run concurrently while
the old one drains. Each held a Prisma pool of `connection_limit=250`, so 2×250 = 500
exceeded the Supabase Supavisor `max_client_conn` limit of 400, and for ~1-4 minutes
post-go-live prod threw
`FATAL: (EMAXCONN) max client connections reached, limit: 400` → intermittent 500s
and `prisma:error` on DB-backed endpoints (people, tool-usage tree, integrations
uploads). One incident window recorded 159 EMAXCONN events with every Prisma op
pinned at the ~30s pool-acquisition timeout. It self-cleared once the old instance
fully drained.

## Diagnosis

`connection_limit=250` came from commit d0c23cdc6 (#363) with the rationale "align
Prisma connection_limit with Fly `max_concurrent_activities`" — a PHANTOM coupling.
The Fly agent fleet holds ZERO DB connections (no asyncpg/psycopg/sqlalchemy/supabase
client anywhere in `agents/`; `psycopg2-binary` was a dead dep, since removed);
workers reach the DB only over the backend HTTP API. Only the SINGLE Render backend
instance opens Prisma pools. The measured layers are Prisma `connection_limit` per
instance → Supavisor CLIENT cap 400 → Supavisor server pool ~32 → Postgres
`max_connections=90`, so EMAXCONN is the CLIENT layer during the 2-instance overlap,
NOT Postgres — a bigger database was the wrong lever. An adversarial pass found the
real arithmetic was worse: each instance holds TWO pools against the same pooler, the
main pool and the Fast Mode cache pool (`fastCacheStore.ts` falls back to
`DATABASE_URL` in prod, `connection_limit=75`), so the original incident was
2×(250+75)=650 against a cap of 400. Setting 200 is the trap value: 2×200 = exactly
the cap, and the migration connection pushes it over.

## Solution

`back-end/src/providers/database.ts` now DERIVES the main-pool limit instead of
hardcoding it, via exported `computeProdConnectionLimit()`:
`backendInstances × DEPLOY_OVERLAP(2) × (limit + FAST_CACHE_POOL_LIMIT(75)) +
RESERVED(40) ≤ maxClientConn(400)`, tunable through `POOLER_MAX_CLIENT_CONN`,
`BACKEND_INSTANCES`, `POOLER_RESERVED_CLIENT_CONN`, `FAST_CACHE_DB_POOL`, and a
`DB_CONNECTION_LIMIT` override. `FAST_CACHE_POOL_LIMIT` is exported from
database.ts and imported by fastCacheStore so the two sizes cannot drift. Cemented by
`back-end/src/tests/structural/db-pool-invariant.test.ts`, including a drift guard.
Verified in prod: the first post-merge deploy cutover ran with ZERO EMAXCONN, zero
errors, p90 40ms, all DB ops ≤29ms. Diagnosis is now one call:
`cd back-end && npx tsx scripts/prod-health.ts` (pool-saturation banner + per-endpoint
p90 vs a rolling baseline). Residual risks recorded: a 3-instance overlap from a rapid
double deploy would exceed the cap, and scaling past 2 backend instances requires
moving fast-cache off the shared pooler — at which point the invariant test fails
loudly by design.

## Human feedback

The human approved the accompanying infra upgrade (Supabase Small→XL: 4 dedicated
cores/16GB, `max_connections=240`, pooler client cap 1000; Supavisor pool_size 30→60;
Render `POOLER_MAX_CLIENT_CONN=1000` + `FAST_CACHE_DB_POOL=150`), and the operating
instruction from this RCA is not to mistake deploy-window EMAXCONN for a
deploy-caused incident: confirm the error is EMAXCONN rather than a schema
"does not exist" error, and confirm it clears on re-probe.

## Reusable lesson

Derive a connection-pool limit from the pooler's client cap divided across every pool
and every instance that can coexist during a deploy — a hand-picked constant copied
from an unrelated concurrency setting guarantees a 500-window on every cutover.
