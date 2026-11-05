---
id: 2026-11-04-code-session-ttl-resolve-retired-without-kill
date: 2026-11-04
title: Resolving a spawn marked TTL-expired code sessions RETIRED without killing their sandbox or deleting checkpoints
surface: back-end
component: code-session-store
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/store.ts resolveCodeSession called markRetired on expired owner sessions, outside the retire path that kills and deletes
symptoms:
  - CodeSession RETIRED with its paused E2B sandbox still present
  - checkpoints of RETIRED code sessions never deleted from R2
  - Code session TTL sweep never reaches an expired session
tags:
  - code-sessions
  - ttl
  - e2b
  - storage-leak
sources:
  - commit 34631aa2ab
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

Expired sessions are retired two ways. `sweepExpiredCodeSessions` (5 oldest per
spawn) calls `retireCodeSession`, which kills the sandbox, deletes checkpoints
and marks RETIRED. `resolveCodeSession` also marked the owner's expired
candidates RETIRED with a bare `markRetired`. Once RETIRED, a session is
invisible to the sweep (which selects PAUSED/ACTIVE), so its paused sandbox and
R2 checkpoints leaked permanently. E2B keeps a paused sandbox indefinitely.

## Diagnosis

`store.ts:197-206` at base 28a7bfc99. Repro (buggy base): a user has 5 older
expired sessions that fill the sweep's batch, plus the owner's expired session
with an E2B sandbox. A spawn (`resolveSpawnCodeSession`) leaves that session
RETIRED with no kill:
`cd back-end && bash scripts/run-blackbox-tests.sh code-sessions` →
`not ok 27 - an expired session is never marked RETIRED with its sandbox alive (sweep or no sweep)`
with `RETIRED without killing its sandbox`. The final test version was re-run
against the reverted fix and failed the same way.

## Solution

Delete the second writer. `ownerCodeSessions` excludes sessions idle past the
TTL (a `lastActiveAt >= cutoff` filter that the existing
`[userId, ownerAgentId, repoKey, lastActiveAt]` index serves), so resolve never
sees them and never marks them. Only the retire path retires. The sweep now
returns its promise; callers still start it without awaiting it.

10k agents: one extra indexed predicate on the existing owner query, and fewer
writes. Open: the sweep still runs only on that user's next spawn, at most 5 per
sweep. A user who never spawns again keeps expired paused sandboxes; a global
bounded TTL job is the follow-up.

Post-fix: same command passes; 5/5 consecutive runs.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A terminal state must have exactly one writer, the path that also releases the resources; a second bare status write hides the row from that path.

Follow-up 2026-11-05 (CodeRabbit 4475153051): `deleteCheckpoint` turned a
manifest read error into "no manifest" and swallowed artifact delete errors, then
deleted the manifest anyway. That left artifacts stored with no index, and the
session was still marked RETIRED. Read and delete errors now propagate and keep
the manifest, and retire stops before `markRetired`. The sweep catches the error
per session, so the others still retire and the stuck one is retried on the next
sweep. Regression: `code-sessions-checkpoint-deletion.cases.ts`.
