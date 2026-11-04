---
id: 2026-11-04-code-agent-status-rows-made-lifecycle-writes-scale-with-run-time
date: 2026-11-04
title: A code agent's 30s status rows and transcript rows made every tool-lifecycle write load O(run time) rows
surface: cross
component: tool-lifecycle-messages
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py _run_agentic_loop wrote a "Claude Code working (Ns)" lifecycle row every 30s; back-end/src/providers/toolLifecycleMessages.ts persistLockedToolLifecycleMessage loaded every row of the toolCallId (transcript rows included) under the call's advisory lock
symptoms:
  - "Claude Code working (" rows every 30 seconds for the same toolCallId
  - "Status update at" lines fill the code agent's Actions Taken summary
  - final code-agent task_complete row missing after a multi-day run
  - Transaction API error: Transaction already closed / timeout on POST /api/agents/:id/messages for a long code agent
tags:
  - claude-code
  - codex
  - multi-day
  - db-growth
  - tool-lifecycle
  - prisma
sources:
  - commit 28a7bfc99
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_run_agentic_loop_long_run_writes_no_repeated_status_rows; back-end/src/tests/blackbox/tool-lifecycle-rows.blackbox.ts
status: fixed
---

## Problem

The code-agent loop posted a TOOL row titled `Claude Code working (Ns)` every
30 seconds (~2,880 rows/day per session) and appended `Status update at Ns` to
the action summary. Every such row is a tool-lifecycle write (it has a
`toolStatus`). `persistLockedToolLifecycleMessage` took the call's advisory
lock and ran `findMany({agentId, role: 'TOOL', metadata.toolCallId})` returning
full rows, including every transcript batch (no toolStatus, large
`code_agent_events`) under the same toolCallId, inside a 10s transaction. No
index covers toolCallId, so the scan read every message of the agent. Work per
write grew with run time until writes (and the final task_complete) could time
out. The parent's "last 10 actions" became ten status lines (finding #7).

Local repros:
- agents: fake clock (+60s per read) over 1.5s of real loop time with a Bash
  tool in flight. Pre-fix: `15 status rows over 8040s with no progress change`.
  Post-fix: 0 rows, no status lines.
- back-end: 1 lifecycle row + 300 transcript rows under one toolCallId on a
  local Postgres; a counting transaction proxy records rows the write
  materializes. Pre-fix: `a lifecycle write loaded 301 rows for a tool call
  with 1 lifecycle row and 300 transcript rows`. Post-fix: PASS (1 row; retry
  deduplicates).

## Diagnosis

1. Elapsed time was persisted as a new row per interval although it is
   derivable from the run's started_at.
2. The lifecycle lookup selected rows by toolCallId only, though every
   candidate it uses (duplicates, fences, user-pause annotations, background
   stamps) carries a toolStatus.
3. Deepest owned cause: per-write work was unbounded by design (rows per tool
   call x all agent messages scanned); the status rows were the dominant
   producer, transcript rows the dominant payload.

## Solution

- agents: a status row only when the reported progress (interactions, Codex
  completed turns) changes, still throttled to 30s; no elapsed in the title or
  message; no summary line (fixes #7: the parent's last-10 actions now show
  real actions).
- back-end: `findToolLifecycleRows` selects ids by agentId + toolCallId +
  `toolStatus IS NOT NULL` in SQL, then loads only those rows. Migration
  `20261104230000_message_tool_call_lifecycle_index` adds partial index
  `Message_toolCallLifecycle_idx` (`agentId`, metadata#>'{toolCallId}',
  metadata#>'{toolStatus}') WHERE role='TOOL'; EXPLAIN shows all three quals as
  Index Cond, so transcript rows are skipped without detoasting. No schema.prisma
  change, so no canonical seed republish.

10k agents: lifecycle writes are O(lifecycle rows of one call) via the index,
independent of transcript length and agent message count; status rows drop from
2,880/day to one per real progress change.

Open (not fixed here): GET /api/agents/:id still returns every message,
including transcript rows (back-end/src/domains/agents/repo.ts findMessages),
and agents/helpers/llm.py's cross-worker fallback reads it; the FE Transcript
tab consumes those rows, so bounding it needs an API contract change.

## Human feedback

None recorded.

## Reusable lesson

Never persist a periodic heartbeat as a row under a key whose writes scan that
key's rows; derive elapsed state, and scope lifecycle lookups to lifecycle rows
with an index.
