---
id: 2026-10-26-shared-retrieval-stores-keyed-without-owner
date: 2026-10-26
title: Shared planner-memory and DEMO-cache stores served one account's runs to other users
surface: back-end
component: planner-memory, demo-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/plannerMemoryStore.ts searchPlannerMemories visibility predicate; back-end/src/providers/demoCacheStore.ts agentFastMode writeEnabled
symptoms:
  - "another user's benchmark run must never surface"
  - "a non-recorder's live outputs must never be stored"
  - benchmarkTaskName IS NOT NULL OR userId = me
  - cross-user leakage through shared retrieval
tags:
  - privacy
  - multi-tenant
  - planner-memory
  - demo-cache
  - fast-mode-cache
sources:
  - memory:scalability-audit-100-seats-20261024.md
  - commit 410a1847d (DEMO-only cache reads, 2026-09-06)
  - PR #1574
repro: back-end/src/tests/blackbox/planner-memory.blackbox.ts ("an owned benchmark run never reaches another user; ownerless fixtures are shared") and back-end/src/tests/blackbox/demo-cache-isolation.blackbox.ts (recorder-only writes; replay-only code-agent proxy)
status: fixed
---

## Problem

The 2026-10-24 100-seat audit flagged two shared retrieval stores that could
move one account's data into another account's agents.

**Planner memory.** Retrieval selected
`benchmarkTaskName IS NOT NULL OR userId = me`. The GET-by-id route had the same
rule. A read-only prod census on 2026-10-26 found 5,701 benchmark rows owned by
Andy's account (`1f85ff25…`), plus 528 owned by a zero-prefixed test id, 390 by `archive-…` ids and 8 by one other user. Benchmarks run on
Andy's prod-sync data. Each of those rows was retrievable by every user with
memory on. On first retrieval, the compressor turns the bundle into the critical
path that is injected into the planner. Prod had 0 ownerless rows; curated
fixtures are ownerless and local-only.

**DEMO cache.** On current main, cache reads only happen for exact DEMO catalog
goals (gated since 410a1847d, 2026-09-06). This narrows the audit's "any
fast-mode agent" claim. However, `agentFastMode().writeEnabled` was
`enabled && !readOnly`, and the code-agent proxy's `resolveFastModeWriteEnabled`
returned true whenever DEMO replay was on. Worse, the code-agent proxies' plain
read route (`/anthropic-proxy/<trace>/v1/messages`, `/codex-proxy/<trace>/…`)
always called `cacheSet` on a 2xx miss; it had no write flag at all. Any user who ran a DEMO prompt would
therefore write their own live router, generator, chat web_search and
code-agent outputs into the shared namespace. That namespace is keyed by goal
text only, and `cacheGetPosition` drift replay ignores owner and fingerprint.
The prod census found that only Andy, Tamy and the Benchmark Hub placeholder
have run DEMO prompts so far, so no leak has been observed yet.

## Diagnosis

Both stores are shared namespaces with no owner column on the read key. Each
store had a rule that decided which rows or writes cross between users, and
that rule was wrong:

- Planner memory treated "is a benchmark" as "is safe to share". A benchmark
  run that executes on a real account's prod-sync data is that account's data.
  Only curated, ownerless fixtures are safe to share; they are built through
  `build_memory_fixture.py`, and the compressor bench asserts they contain no
  PII.
- In the DEMO cache, the write gate depended on the goal, not on the writer's
  identity. The Python worker already froze DEMO namespaces (`cache_write_allowed`).
  The backend chat and code-agent writers did not, so any user's run could
  contribute rows that later replay to another user.

Repro (buggy revision b3679ea7b, system PG):
`ROSE_USE_SYSTEM_PG=true CONDUCTOR_WORKSPACE_NAME=s2rca CONDUCTOR_PORT=4610 bash back-end/scripts/run-blackbox-tests.sh planner-memory`
failed with "another user's benchmark run must never surface". The same command
with `demo-cache-isolation` failed with "a non-recorder's live outputs must never
be stored" and "codex non-recorder URL https://api.example.com/codex-proxy/0fcbec29584c300d"
(no replay-only route existed, so a non-recorder session read and wrote).

## Solution

- Planner memory: one visibility rule in `plannerMemoryStore.ts` shows a row
  when it is the caller's own row (`userId = me`), or when it is an ownerless
  benchmark fixture (`userId IS NULL AND benchmarkTaskName IS NOT NULL`).
  Search SQL and the GET route (through `plannerMemoryVisibleTo` /
  `service.visibleTo`) share this rule. Benchmark identities still retrieve
  their own benchmark rows, and local fixtures stay shared.
- DEMO cache: `agentFastMode().writeEnabled` and `resolveFastModeWriteEnabled`
  now require a recorder account (`FAST_MODE_WRITE_THROUGH_USER_IDS`: Andy and
  Tamy, which also own benchmark, sim and demo runs). Other users still replay
  DEMO recordings, but they never write. The Python LLM contexts consume
  `writeEnabled` from `/api/fast-cache/agent-flag`, so the gate propagates to
  them. Python tool-level writers (web_search, web_fetch, browser_use) compute
  their own write bit but stay frozen on DEMO trees through
  `cache_write_allowed_for_agent`.
- Code-agent proxies: the proxy routes are unauthenticated and the sandbox
  controls its own base URL, so a URL prefix cannot grant writes (CodeRabbit,
  PR #1574). The plain trace route is now replay-only. Writes require a
  `record.<sig>` (read+write) or `record-only.<sig>` (write-only) segment, where
  `<sig>` is an HMAC of the exact trace segment keyed by the server-only
  `SUPABASE_JWT_SECRET` (`demoCacheWriteCapability`, verified with
  `timingSafeEqual`). `codeAgentFastModeEnv.proxyPath` signs only recorder
  sessions. Forged, unsigned or absent capabilities serve the live response
  without storing it, and they still consume the trace ordinal so the session
  stays aligned. The isolation blackbox mounts the real routers against a 2xx
  fake upstream. On the previous commit it failed with
  `codex plain: stored=true`.
- Open follow-up: Codex rose-harness sandboxes receive `ROSE_API_KEY` (the
  backend API key, `providers/e2b.ts`), which can call `/api/fast-cache/set`
  directly; that route guard belongs to lane S1.
- Browser HTTP write-through (follow-up, lane S9): `BrowserHttpCache.record`
  was the only tool-level writer that skipped `cache_write_allowed_for_agent`.
  It called `cache_set` with neither the agent nor the tree root, so a non-DEMO
  browser child under a DEMO root stored responses under `browser_http:global:`
  keys, which every DEMO replay of that URL reads. On main a scratch record
  returned `True` with one store. The cache now takes the browser `agent_id`,
  resolves the tree-root gate once per run, and passes `goal` to `cache_set`.
  Regression: `test_browser_http_write_skips_child_under_demo_tree_root` and
  `test_network_cache_install_threads_agent_id` in
  `agents/tests/demo_cache/test_browser_cache.py` (agents coverage).
- Open follow-up: recorder write-through for `browser_http`, web_search and
  web_fetch uses global keys, so a recorder's private fetches can replay into
  DEMO sessions.
- Golden reference: `claude-code-src/src/tools/AgentTool/agentMemory.ts:12-62`
  scopes persistent memory to the user's own home, project or local directory.
  The only shared memory there is checked-in (curated) project memory. The fix
  converges on that pattern: owned history stays private, and curated fixtures
  are the shared corpus.
- 10k agents: there is no new query or round trip. Retrieval adds one
  predicate on already-filtered rows. The write gate is an in-memory set lookup
  on the agent row that `agentFastMode` already reads.

## Human feedback

The parent relayed Andy's design constraints: sim guests write sim.* rows to
the prod store by design, the mass-agent benchmark is fully demo-cached, and the
cache serves demos. All three still hold, because they run as recorder
accounts.

## Reusable lesson

A shared retrieval namespace must decide cross-user visibility by owner identity, never by a content label such as "benchmark" or "demo goal".
