---
id: 2026-09-06-background-hub-child-index-sync-io-starved-backend
date: 2026-09-06
title: Background Hub child indexing synchronously read 907 MB and starved the backend
surface: back-end
component: benchmark-hub-resolution
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/benchmarkHubLookup.ts buildChildIdIndex scanned every archived full bundle through synchronous local reads without an event-loop yield or persistent reverse index
symptoms:
  - web_search sample 1 missed milestones
  - GET /api/agents/79601802-1a8e-4499-9a53-9e14957d87ff -> 404 duration_ms=21119
  - background Hub indexing did not yield before the second bundle load
tags:
  - benchmark-hub
  - event-loop-starvation
  - synchronous-filesystem
  - semantic-latency
sources:
  - PR #1266
  - commit 4c5a7969b4308da22aad17d673231952f31e45fa
  - agent cf268629-1a69-46e3-a3e2-4d2ab7c86304 (durable FE link in Solution)
  - agent 543792d4-38fa-4274-89cd-5fd5483dd697 (durable FE link in Solution)
  - hub run rca-semantic-web-search-20260906
repro: back-end/src/tests/blackbox/benchmark-hub-index.blackbox.ts
status: fixed
---

## Problem

The local deploy semantic suite passed 12 checks but its first measured web-search
sample missed the first-response, tool-finished, and final-answer milestones. The
browser submitted while the shared backend was available, but the backend did not
begin the measured `POST /api/agents` until roughly 21 seconds later.

The backend log captured the stall at the owned boundary. A provisional client UUID
hit `GET /api/agents/79601802-1a69-46e3-a3e2-4d2ab7c86304`; its Prisma `Agent
findFirst` completed in 3 ms at `23:48:35.340Z`, but the route returned its 404 only
at `23:48:56.456Z` with `duration_ms=21119`. Once the backend resumed, measured
agent `cf268629-1a69-46e3-a3e2-4d2ab7c86304` hit the router, web-search, and
generator caches and completed in milliseconds. The local Hub directory contained
225 bundles totaling 907 MB, including several 55–56 MB bundles.

## Diagnosis

Critical path:

`semantic browser creates client UUID -> GET /api/agents/:id before POST commit ->
getAgentDetail archive fallback -> findAgentAcrossRuns -> scheduleChildIdIndex ->
buildChildIdIndex -> getRunBundle/getObject -> backend event loop -> measured POST`.

The first bad boundary was `buildChildIdIndex`. The September 1 miss-fast change
(commit `4c5a7969b4`) correctly removed a full bundle scan from the foreground
request, but scheduled the same scan as a promise chain. Local `getObject` still used
`fs.readFileSync`, and each already-resolved `await` continued through the microtask
queue. Reading and parsing all 907 MB therefore monopolized the Node process before
timers or HTTP callbacks could run. The 21.119-second 404 ending immediately before
queued requests flushed establishes backend event-loop starvation; the traced
archive-fallback path plus the isolated red/green reproduction identifies the Hub
index builder, rather than the timing observation alone.

The deepest owned cause is a concurrency inefficiency: work labeled background had
no event-loop scheduling contract, and the prior unit guard asserted only that the
foreground function did not contain the scan. It did not test that live timers could
run while the scheduled scan progressed. This is a relative recurrence of the
September 1 Prisma-starvation defect, not an archive match: searches for `background
Hub indexing starved the event loop GET /api/agents 21119ms` and `client UUID before
POST benchmark archive child index synchronous filesystem` found no case with this
boundary.

The permanent reproduction runs the real legacy index builder with a loader that
models the synchronous local bundle boundary and schedules a marker during every
load. With the per-bundle yield removed, the unchanged command `npx tsx
src/tests/blackbox/benchmark-hub-index.blackbox.ts` exited 1 with `background Hub
indexing did not yield before loader 2`.

## Solution

Benchmark Hub uploads now persist a versioned, compact `agent-run-index.json` under
the existing cross-process index lock. It contains roots and children, is updated on
upload/delete, and is cached by each backend with one bounded refresh per five
seconds. `findAgentAcrossRuns` no longer calls `listRuns`, rebuilds a set, or scans
summaries for each provisional UUID; after the compact map is loaded, hit/miss
resolution is one `Map.get`. Exact per-run visibility tombstones keep a stale
replica map from serving a deleted bundle before its next refresh.

Archives created before the compact index take a one-time compatibility backfill.
That backfill is persisted as complete, uses `node:fs/promises`, and explicitly
yields before every full-bundle read/parse. The stricter blackbox requires an event-
loop marker scheduled by each loader to run before the following loader. The unit
suite additionally pins the persistent update path and exercises direct lookup in a
10,000-agent map without any loop, `find`, or `some` in the resolver.

Catalog and reverse-index reads on migrations and read-modify-write mutations are
strict: a transport fault, malformed catalog, invalid revision/completion flag, or
invalid agent mapping rejects the operation. It cannot be reinterpreted as an empty
archive or published as `complete: true`. Behavioral tests cover both catalog and
bundle read faults before persistence, as well as malformed compact-index fields.

This removes unbounded archive work from the steady-state request/startup path and
keeps the one-time legacy migration cooperative. It deliberately does not claim
that all Hub serialization is non-blocking: `JSON.stringify` on upload and
`JSON.parse` for an explicitly requested full run remain synchronous. The real
907 MB archive probe measured 399 ms maximum event-loop lag after the cooperative
change, bounding a migration slice to one bundle instead of the former 21-second
archive-wide monopoly. A route timeout or web-search retry would only hide the
shared backend scheduling defect.

The exact unchanged semantic command was:

```bash
SEMANTIC_WORKERS=4 BACKEND_PORT=3001 FRONTEND_PORT=3002 bash scripts/run-deploy-stage semantic -- bash front-end/scripts/run-semantic-tests.sh
```

`git diff --quiet d32d6bb2122ff867f2ca794fba73cedae492ee8d --
front-end/scripts/run-semantic-tests.sh
front-end/tests-e2e/chat-lifecycle-latency.spec.ts` exited 0, proving that neither
the semantic entrypoint nor the latency definition changed between the failing
baseline and the fixed rerun.

The failing stage log
`.context/deploy-runs/20260905-232223-291800/logs/semantic-20260905-234737-431958.log`
recorded 12/13 passing and timed out web-search sample 1 for agent
[`cf268629-1a69-46e3-a3e2-4d2ab7c86304`](https://www.roselabs.ai/?agent-id=cf268629-1a69-46e3-a3e2-4d2ab7c86304).
After the fix, the identical command's
`.context/deploy-runs/20260905-232223-291800/logs/semantic-20260906-002910-725285.log`
recorded 13/13 passing; web-search sample 1 for
[`543792d4-38fa-4274-89cd-5fd5483dd697`](https://www.roselabs.ai/?agent-id=543792d4-38fa-4274-89cd-5fd5483dd697)
completed in 1,835 ms and all five web-search samples stayed below the 5,000 ms
ratchet. Both transcript links were published in durable Hub run
`rca-semantic-web-search-20260906` and independently verified through the production
agent API and FE origin (six messages each, with no live browser tasks). The first
legacy backfill persisted a complete 766-agent reverse index in a 59,801-byte file;
on a fresh backend process, the first archived-agent GET then returned HTTP 200 in
616 ms without scanning the 907 MB archive.

## Human feedback

None recorded.

## Reusable lesson

Make every background bulk scan prove that live timers and requests advance between items; moving synchronous work behind an unawaited promise does not make it non-blocking.
