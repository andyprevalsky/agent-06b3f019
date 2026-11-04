---
id: 2026-11-04-agent-release-killed-persistent-code-session-outside-its-lifecycle
date: 2026-11-04
title: Agent release killed persistent code-session sandboxes with a bare Sandbox.kill, leaving the CodeSession ACTIVE, leased and without a checkpoint
surface: back-end
component: agent-cleanup-code-sessions
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/agentCleanup.ts releaseAgentCodeSessions (codeSessionReleaseDependencies.killSandbox / markClosed) killed the task's sandbox and closed the ClaudeCodeSession row without touching its CodeSession
symptoms:
  - CodeSession state=ACTIVE with leaseExpiresAt in the past and latestCheckpointSeq=0
  - latest ClaudeCodeSession CLOSED with closeReason NULL
  - Killing 1 code sandbox(es) for agent
  - a retried spawn after a deploy cutover starts a parallel session on a new branch
  - Code session is leased by another spawn; starting a parallel session
tags:
  - code-sessions
  - e2b
  - agent-cleanup
  - cutover
  - archive
  - persistent-sessions
sources:
  - commit a3f8dd421c
  - benchmark run claude-code-agent smoke on prod (user 606fe9fc-bb22-4992-a022-dea269afec14; read-only query 2026-11-04)
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

Production (read-only query, 2026-11-04) had 101 of 228 `CodeSession` rows in
`state=ACTIVE` with an expired lease and `latestCheckpointSeq=0`. Each had exactly
one `ClaudeCodeSession`, `CLOSED` with `closeReason` NULL, and an E2B sandbox
(55 claude, 46 codex, 2026-10-26 to 2026-11-04). The sessions never reached
PAUSED or RETIRED and had no checkpoint. Their work could not be recovered, and
the next spawn of their owner could not take the lease for an hour.

All 101 belonged to `claude-code-agent` smoke-benchmark agents. Every agent was
`FAILED` with `statusMessage = 'Archived by user'` and `deletedAt` set. The task
row closed a median 0.376 s after `deletedAt`.

## Diagnosis

Critical path: `DELETE /api/agents/:id` → `deleteAgentRecursive` (agentKill.ts)
→ `cleanupAgentSessions` → `releaseAgentCodeSessions` → `Sandbox.kill(sandboxId)`
plus `claudeCodeSession.update({status: CLOSED})`. Nothing on this path reads or
writes the task's `CodeSession`, so the session keeps its `ACTIVE` state and its
lease, and no checkpoint is written. It is the only writer that closes a task
with a NULL `closeReason` (`closeClaudeCodeSession` always sets one). The 0.376 s
gap matches the archive transaction followed by `cleanupAgentSessions`.

The same function serves `releaseTerminatedWorkflowResources`
(`agentRestartService.ts:181` cutover, `workflowDescendantCleanup.ts:297`). After
the 45-minute generation deadline, a cutover therefore hard-killed a persistent
session's sandbox. That is the sandbox the 2026-10-01 drain fix deliberately left
running for reattach (relative case
`2026-10-01-deploy-restarted-in-flight-browser-and-code-agents-from-scratch`).
The retried tool then found the session leased by a dead owner and forked a
parallel session on a new branch.

Step 5a ladder:
1. The release closed the task without the session. Evidence: the query above
   and agentCleanup.ts:106-130 at base 28a7bfc99.
2. Why possible: `agentCleanup` predates persistent sessions and kept its own
   kill path beside the session lifecycle (`closeClaudeCodeSession`: checkpoint,
   pause, markPaused; `retireCodeSession`: kill, delete checkpoints, RETIRED).
   Two code paths owned "stop this code sandbox", and only one knew about
   sessions.
3. Next rung: the design does not say which owner releases a session on agent
   death. That is a design question, and its answer (route through the
   lifecycle) is the fix at rung 2. Stop.

Repro (local, buggy base 28a7bfc99):
`cd back-end && bash scripts/run-blackbox-tests.sh code-sessions`
- `not ok 21 - a terminated workflow (cutover / descendant) checkpoints and pauses its code session instead of killing it` — `a persistent session sandbox is never killed by a cutover` (actual `['sb-cutover-…']`, expected `[]`)
- `not ok 22 - archiving the agent that owns a code session retires it` — expected `'RETIRED'`, actual `'ACTIVE'`

## Solution

`releaseAgentCodeSessions` now routes every task that has a `codeSessionId`
through the session lifecycle (`releasePersistentCodeTask`):
- An interrupted run (cutover, descendant cleanup) goes through the canonical
  `closeClaudeCodeSession(reason: 'cancel')`: checkpoint, E2B pause, `markPaused`,
  and a resumable close reason. The retried spawn resumes the same paused sandbox
  and branch.
- Archiving the session's owner (`cleanupAgentSessions` → `{retire: true}`) calls
  `retireCodeSession`: kill the sandbox, delete checkpoints, mark RETIRED. An
  archived agent that only shares the session pauses it instead.
- One-shot sandboxes (no session) keep the kill-then-close contract, including
  "a failed kill stays ACTIVE for retry" (`agent-code-session-release.test.ts`).

Siblings prevented: the cutover branch fork, the old CLI running beside the
replacement (it is paused), and rows that leak as ACTIVE.

10k agents: per released agent, one indexed `CodeSession` read per task, then the
existing close or retire path. No fan-in, and no work per other agent.

After the fix the same command passes (`# pass 26 # fail 0`). Five consecutive
runs passed with the test code unchanged.

The 101 existing prod rows are not migrated. Their sandboxes were already
killed, so they hold no compute. They are orphan rows that the user's next spawn
sweep retires once past the TTL.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

When a resource gains a lifecycle (pause, checkpoint, retire), route every teardown path through that lifecycle, so no older kill path can bypass it.
