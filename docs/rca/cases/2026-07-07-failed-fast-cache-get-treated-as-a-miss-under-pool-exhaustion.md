---
id: 2026-07-07-failed-fast-cache-get-treated-as-a-miss-under-pool-exhaustion
date: 2026-07-07
title: A 500 from /api/fast-cache/get under fan-out was treated as a cache MISS, so existing entries were re-billed as live LLM calls
surface: back-end
component: fast-cache
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/fastCacheStore.ts — a new PrismaClient (and pool) was built per read in prod, exhausting Postgres under 50-way fan-out
symptoms:
  - "760 get_failed in one run"
  - "/api/fast-cache/get returns HTTP 500 under a 50-way for_each fan-out"
  - tree price never drops on a re-run that should replay at $0
tags:
  - fast-cache
  - prisma
  - connection-pool
  - fan-out
  - cost
sources:
  - memory:project_mass_agent_run_false_miss_rootcause
  - commit 28aa599d
repro: none-recorded
status: fixed
---

## Problem

The `mass-agent-run-0` prod agent (goal hash `4ae3193053ac1d8f`) fans out via
`for_each` to 50 creator-analysis children. Repeat runs that should have replayed
at ~$0 kept costing real money — "the price never drops in fan-out". Evidence:
**760 `get_failed`** events in a single run, from `/api/fast-cache/get` returning
HTTP 500 under the 50-way fan-out.

## Diagnosis

Not cache drift and not phantom cost. `fastCacheStore.ts` built a **new
PrismaClient per read** in production, so each concurrent fast-cache GET opened
its own connection pool; the 50-way fan-out exhausted Postgres and the endpoint
500'd. The worker then treated a failed GET as a **MISS** — indistinguishable from
"no entry" — and issued an expensive live LLM call for an entry that already
existed. So a pool-capacity problem presented as a cost/caching problem.

Explicitly confirmed non-issues during this RCA: cost accounting is correct
(`agent_workflow.py:1968` records $0 for `from_fast_cache` replays, `:1989` for
`-claude`/`-gpt` claudeAuth), the plan is deterministic
(`dag_param_populator:p:1` caches exactly 50 creators and replays at cost 0), and
child-count variance (51/63/77) is a larger budget spawning more of the tree, not
list growth. Real residual cost is genuine `explore_agent` misses on
`-anthropic`-suffixed models served by Rose's own key — by design, since explore
uses `rose-1-lite` rather than claudeAuth to avoid 429ing the user's Max token
across 50 children.

## Solution

Commit `28aa599d`: (1) `fastCacheStore.ts` uses a PrismaClient **singleton in all
environments** plus `connection_limit=25` and `pool_timeout=20` on the URL; (2)
`fast_cache/client.py` `cache_get_record` retries a failed GET 3× before conceding
a miss. `get_failed` went 760 → 0. The second half is the generalizable part: a
transport failure must never be collapsed into a semantic "not found", because
that silently converts an infrastructure fault into paid work. At fan-out scale
the per-read-client pattern is the shape to look for — connections grow with the
number of concurrent agents rather than with the work.

## Human feedback

None recorded.

## Reusable lesson

Never let a failed cache read fall through as a MISS — retry it and distinguish
transport failure from absence, or every pool exhaustion becomes a billed
recomputation.
