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
  - "fixtures leave no agent or trajectory history behind: 9 fixture agents left 9 agent rows and 19 agent_trajectories rows behind"
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
- In these three runs, the replay cache returned a grep call that failed pattern-safety
  analysis, so the largest row stayed at 6,784 characters. Byte growth depends on which
  grep the live LLM samples. The originating box reached megabytes; this box did not.
  The accumulation itself, and the self-referential grep path, are deterministic.

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
  `AgentTrajectorySearch` and `AgentTrajectoryAgent` rows. On startup it purges fixture
  agents left by earlier runs in long-lived shard databases. A closing case,
  `fixtures leave no agent or trajectory history behind`, asserts that no agent or
  trajectory row from this run survives. Every route assertion and timeout is unchanged.
- `NonBlockingFileCache` keys its in-memory maps by the sha256 digest (originating RCA
  patch 098ecbc28), with unit case 5 asserting no retained key exceeds 64 characters.
- Pre-fix: the new case failed with `9 fixture agents left 9 agent rows and 19
  agent_trajectories rows behind`. Post-fix: the same command passed 14/14, and the
  purge removed every earlier fixture agent and trajectory row (0/0). The unit case fails
  on main (`mem retained a 1000043-character request key instead of its digest`) and
  passes on the patch.
- Product-side grep bound: not changed here. The per-record cap is 250 lines, not
  characters, so a production chat that greps its own earlier grep results could
  compound the same way. Bounding grep result characters changes an LLM-visible tool
  result, an approval-gated surface, and no production occurrence was observed. It stays
  an open follow-up for an approved tool-result size bound.
- Golden reference: not applicable (no approval-gated hunk).
- 10k-agent behavior: test-only change. Production creates no new rows, queries,
  channels or subscriptions.

## Human feedback

None recorded.

## Reusable lesson

A blackbox fixture that only needs a row must seed it directly and hard-delete it, never through a path that starts live LLM work or leaves user-wide history in a database that persists across runs.
