---
id: 2026-11-07-report-bug-fixture-live-chat-compounds-persistent-shard-history
date: 2026-11-07
title: report-bug blackbox fixture started live chats whose agent_trajectories history persisted in the coverage shard DB and fed later runs' chats until the shard-2 server ran out of heap
surface: back-end
component: report-bug-blackbox-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/report-bug.blackbox.ts createAgent/deleteAgent — the fixture created its agents through POST /api/agents (chat mode, live router + grep LLM chat) and removed them through DELETE /api/agents/:id, which only archives, so every run's chat messages stayed in the persistent victoria_<workspace>_s<N> shard DB as user-wide agent_trajectories history
symptoms:
  - "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"
  - backend-coverage-blackbox shard 2 domains all fail with "fetch failed" after the shard server died
  - largest LLM dump grew 17 KB -> 0.2 MB -> 1 MB -> 7.8 MB -> 28.7 MB across runs on one devbox
  - "Compaction did not reduce context"
  - "the suite's fixtures made 72 model calls: https://api.cerebras.ai/v1/chat/completions, https://openrouter.ai/api/v1/chat/completions"
tags:
  - blackbox
  - coverage
  - sharded-coverage
  - heap-oom
  - fixture-hygiene
  - agent-trajectories
  - grep
  - fetch-capture
  - replay-cache
sources:
  - PR #1760
  - commit cdb8ce580a3e66dd27fed4558094b3bd7befc797 (merge)
  - commit 3e770c9e10be3ee23f6cf0a2ad4a523b1241789e (PR #1749 merge, originating deploy)
  - commit 79e007df49786d17071719477a283cbe8ed7b446 (failed source)
  - commit 098ecbc28 (originating RCA patch, NonBlockingFileCache digest keys)
  - plan:docs/handoffs/backend-blackbox-heap-growth/GOAL.md (originating devbox ed7a3716-f3df-4537-8207-8058623127e1)
repro: back-end/src/tests/blackbox/report-bug.blackbox.ts ("fixtures leave no agent or trajectory history behind"); back-end/src/tests/unit/non-blocking-fetch-cache.test.ts (case 5, digest-keyed memory)
status: fixed
---

## Problem

On devbox ed7a3716 the deploy backend coverage gate (`npm run test:coverage:sharded`
through `scripts/deploy_test_backend.py`, `CONDUCTOR_WORKSPACE_NAME=backend-coverage-blackbox`)
lost its shard-2 test server. At 11:37:18Z the devbox memory watchdog SIGTERMed it at
4.67 GB RSS; at 13:29Z it died with `FATAL ERROR: Reached heap limit Allocation failed -
JavaScript heap out of memory` (native stack in node::crypto Hash Decode /
String::WriteUtf8 / SlowFlatten). Every later shard-2 domain (benchmarks-hub,
benchmarks-test-prompts, browser-provider, code-preview, codex-code, send-sms,
tool-usage, tools, vapi, vcard, waitlist, webhooks, x402) failed with `fetch failed`, so
the coverage threshold was unverified. The originating RCA measured the largest LLM
dump growing 17 KB -> 0.2 MB -> 1 MB -> 7.8 MB -> 28.7 MB over about eight runs against
the same persistent shard databases. Those logs stayed on the originating box.

Reproduced on devbox aa460e55 (fresh database) with
`CONDUCTOR_WORKSPACE_NAME=heaprepro CONDUCTOR_PORT=4710 ROSE_USE_SYSTEM_PG=true bash
scripts/run-blackbox-tests.sh report-bug` run three times against one database:

- after each run the fixture agents' chat rows in `AgentTrajectorySearch` accumulated:
  ASSISTANT 10 -> 19 -> 28, TOOL 10 -> 19 -> 28, USER 9 -> 18 -> 27; none were removed.
- the TOOL rows were the chat's `Grep {"pattern":"blackbox fixture","sources":["documents","agent_trajectories","drive"]}`
  results, and their matches were other fixture agents' messages: each run's chats read
  the earlier runs' chats.
- Those chat calls were live, not replayed: the replay key embeds the whole request body,
  and that body changes as history grows. Each pre-fix run wrote new `chat/completions`
  entries into `.context/fast-forward-cache/outbound-fetch`, which only happens on a
  cache miss. Every run therefore spent real LLM calls and read different history.
- In these three runs the chats' later grep calls failed pattern-safety analysis, so the
  largest row stayed at 6,784 characters. Byte growth depends on which grep the live LLM
  samples. The originating box reached megabytes; this box did not, and the heap OOM was
  not reproduced here. The accumulation and the self-referential grep path are
  deterministic.

## Diagnosis

Critical path: report-bug.blackbox.ts `createAgent` -> POST /api/agents (no
`start_phase`) -> `launchAgentWorkflow` -> `startChatMode` -> `handleChatMessage`
(router + generator LLM calls through fetchCapture/NonBlockingFileCache replay) ->
the router greps the goal text "report-bug blackbox fixture" across the user's
`agent_trajectories` -> the grep result is stored as a TOOL message, mirrored into
`AgentTrajectorySearch` by trigger -> `deleteAgent` -> DELETE /api/agents/:id archives
the agent only -> the shard database survives to the next run.

1. First bad data: the fixture creates chat-mode agents for ANDY_USER_ID, but the suite
   only needs an owned root agent row to exercise the report-bug routes. Each one runs a
   live LLM chat whose grep matches the same goal string in earlier fixture chats.
2. Why possible: deleting through the API only archives the agent, and
   `AgentTrajectorySearch` has no foreign key to `Agent` (it is user-wide history). The
   coverage shard databases (`victoria_<workspace>_s1/_s2`) are reused across runs, so
   history only grows.
3. Why it became a heap failure: a grep result serializes matches as one JSON line, so
   the 250-line per-record snippet cap does not bound characters. Each generation's grep
   rows embed the previous generation's rows, and the next chat request body carries them
   all. In the test server, the fetch-capture log (`captures[].requestBody`) and
   `NonBlockingFileCache` (`mem`/`generations`/`invalidated`, keyed by the full replay key
   containing the request body) retained every such body for the server's lifetime.
   With 16M-character bodies that was about 64 MB per call, until the V8 heap limit.

The deepest owned cause is test-fixture data hygiene: a suite left user-wide,
grep-visible history in a persistent database and drove live LLM traffic it does not
assert on. The cache keying is a secondary amplifier.

## Solution

- `report-bug.blackbox.ts` seeds its fixture root agents directly through Prisma
  (`import './assertLocalDatabase'` guards against a non-local database), so no chat or
  LLM call runs. It hard-deletes the agents with their self-report side effects,
  `AgentTrajectorySearch` and `AgentTrajectoryAgent` rows. Seeded rows carry a durable
  title (`report-bug blackbox fixture (seeded by report-bug.blackbox.ts)`). On startup the
  suite purges marked rows that an interrupted earlier run left behind, and leaves
  unmarked rows with the same goal untouched (CodeRabbit review finding). A closing case,
  `fixtures leave no agent or trajectory history behind`, asserts that no agent or
  trajectory row from this run survives. Every route assertion and timeout is unchanged.
  Every suite request carries one `X-Capture-Token`. A second closing case,
  `fixtures start no agent run or model call`, reads `/api/test/captures?token=` and
  fails on any outbound call with a `"messages"` body. A chat started from a fixture
  agent inherits the token, so a return to POST /api/agents fails this case even with a
  hard delete. The history case counts this run's ids and every marked fixture agent,
  which also covers the startup purge.
- `run-blackbox-tests.sh` adopting an existing stack's Postgres (system or Docker) now
  seeds the database named by the stack manifest (`stack_manifest_db_name`,
  `.database.name`) instead of defaulting to `victoria`, so Prisma-seeded fixtures land in
  the database the backend under test reads (CodeRabbit review finding; regression in
  `back-end/scripts/local-db-container.test.sh`).
- `NonBlockingFileCache` keys its in-memory maps by the sha256 digest (originating RCA
  patch 098ecbc28), with unit case 5 asserting no retained key exceeds 64 characters.
- Pre-fix (the suite with the old POST/DELETE fixture): `fixtures leave no agent or
  trajectory history behind: fixture agents left 9 agent rows and 29 agent_trajectories
  rows behind`, and `fixtures start no agent run or model call: the suite's fixtures
  made 72 model calls: …supabase…/realtime/v1/api/broadcast,
  https://api.cerebras.ai/v1/chat/completions, https://openrouter.ai/api/v1/chat/completions`
  (13/15). An earlier, narrower check counted 19 rows because the asynchronous chats were
  still writing when it ran. Post-fix: the same command passed 15/15, the purge removed
  the 9 agents the pre-fix run left, and five consecutive runs passed. The unit case fails
  on main (`mem retained a 1000043-character request key instead of its digest`) and
  passes on the patch.
- The original gate passed: the standalone `npm run test:coverage:sharded` on a
  persistent database (merged coverage 90.32% lines; peak shard server RSS 1.38 GB), and
  `backend-coverage-blackbox` in every staged PR #1760 deploy sweep on 8cc6df20b,
  7c092b611, ddfe9f288, c9d4f587b and 6e347fb7f. Merged as cdb8ce580; production
  verification passed (Render, endpoint probes, production semantics).
- Product-side grep bound: not changed here. The per-record cap is 250 lines, not
  characters. A read-only production query (2026-11-07, TOOL rows from the last 30 days
  that embed `agent_trajectories/` matches) found 213 rows: 78 over 100,000 characters,
  p99 827,698, max 1,072,188. They hold 200–250 trajectory references with almost no
  double-escaped content: large flat pages, not proven grep-of-grep compounding. Bounding
  grep result characters changes an LLM-visible tool result, an approval-gated surface.
  It is a tracked follow-up (memory `grep-result-char-bound-followup`).
- `fetchCapture` keeps whole `captures[].requestBody` for the server's lifetime because
  blackbox suites such as send-sms, user-ui and download-telemetry assert on outbound
  request bodies. With normal-sized bodies this is bounded by the suite inventory. The
  fixture compounding made it unbounded. A size cap there is a separate follow-up.
- Other suites still create archived chat agents for the same user (demo-cache
  "fastmode bbtest <ts>", agents-list-create "Simulator test", data-real-user
  "coverage test agent for … grep"). They are follow-ups under the same lesson; the
  observed growth was attributed to this fixture.
- Golden reference: not applicable (no approval-gated hunk).
- 10k-agent behavior: test-only change. Production creates no new rows, queries,
  channels or subscriptions. The open production risk is grep result size per tool call,
  which grows with a user's history, not with agent count.

## Human feedback

None recorded.

## Reusable lesson

A blackbox fixture that only needs a row must seed it directly and hard-delete it, never through a path that starts live LLM work or leaves user-wide history in a database that persists across runs.
