---
id: 2026-11-06-code-tasks-never-released-on-agent-terminal-transition
date: 2026-11-06
title: A finished agent's code tasks stayed ACTIVE and expired sessions were never swept, so E2B sandboxes outlived their owners
surface: back-end
component: code-session-release
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentStatusService.ts updateAgentStatus released browser sessions on the first terminal transition but never code tasks; the only code release hooks were delete, cutover and descendant cleanup
symptoms:
  - ClaudeCodeSession status ACTIVE after the owning root agent COMPLETED (tasks dd8ef6a8 and 631d4602, session 50939d30)
  - 144 ACTIVE ClaudeCodeSession rows with a sandboxId, 142 older than a day
  - E2B paused=2313 running=4 with ~2150 untagged and ~210 stack-tagged sandboxes no prod row references
  - Terminal COMPLETED left the code task ACTIVE (status=ACTIVE); its sandbox is never released
  - there is no scheduled TTL sweep; only a spawn by the same user retires expired code sessions
tags:
  - e2b
  - sandbox-leak
  - code-sessions
  - agent-terminal-transition
  - ttl-sweep
sources:
  - commit d420861176
  - commit a3f8dd421c
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
repro: back-end/src/tests/blackbox/agents-terminal-code-release.cases.ts
status: fixed
---

## Problem

Andy asked for cleanup so nothing is left hanging. Read-only inventory of the shared E2B key
(2026-11-06 05:08Z): 2,361 paused + 7 running. 2,150 paused carry only `{createRequestId}`
(untagged), 211 paused carry a `roseStack`. Against prod rows (read-only `psql`
in a READ ONLY transaction): 101 untagged and 11 tagged paused sandboxes are
referenced by a prod CodeSession/ClaudeCodeSession (resumable, keep); 2,049
untagged and 200 tagged are referenced by nothing. All 200 tagged unreferenced
sandboxes are `host:` origin (37 devbox/benchmark stacks, 0 from Render). Prod
tables: 144 `ClaudeCodeSession` rows are ACTIVE (142 older than a day, the oldest
from January); 103 `CodeSession` rows are ACTIVE with expired leases whose owner
agents are all "Archived by user".

Concrete incident: Rose-project session 50939d30 (agent 1a3d495c, 04:13-04:26Z)
had four spawn attempts on one sandbox. Render logs show two close paths
("Paused sandbox ... code session 50939d30" at 04:20:54 and 04:26:11) and no
release after the root COMPLETED at 04:26:30. Tasks dd8ef6a8 and 631d4602 (the
superseded Temporal-retry attempts) stayed ACTIVE.

## Diagnosis

1. Why were the tasks ACTIVE? `updateAgentStatus` (first terminal transition)
   calls `releaseTerminalBrowserSessions` and, for roots, trace/purchase cleanup,
   but nothing for code tasks. `releaseAgentCodeSessions` has exactly three
   callers: delete (`agentKill`), cutover (`agentRestartService`) and descendant
   cleanup. A normal COMPLETED/FAILED agent is none of them. This is the same
   class the browser release case fixed ("release used to hang off agent DELETION
   only"), left unported to code tasks. Proof: the unchanged-code blackbox
   `PATCH /:id/status COMPLETED closes the agent's still-ACTIVE code tasks` fails
   with `Terminal COMPLETED left the code task ACTIVE (status=ACTIVE)`.
2. Why does an unreleased task become a permanent paused sandbox? Persistent
   sessions are created with `lifecycle: {onTimeout: 'pause'}`
   (`e2bCodeSessionSandbox.ts` `lifecycleOptionsFor`), so an unreleased sandbox
   is auto-paused by E2B after the idle window, and paused sandboxes have no TTL.
3. Why does nothing retire them later? The code-session TTL (14 days) is swept
   only by `sweepExpiredCodeSessions(userId)`, started by a spawn of the same
   user (`spawn.ts`, `sessionRunner.ts`). A user or stack that never spawns again
   is never swept. Proof: `sweepAllExpiredCodeSessions` did not exist; the
   lifecycle blackbox case fails with `there is no scheduled TTL sweep`.
4. Why can't the 200 devbox leaks be reaped? `reapOrphanedCodeSandboxes` runs
   only in production and only for its own `roseStack`; a devbox stack's DB is
   dropped or the devbox is destroyed without `kill-stack-sandboxes` (run.sh only
   runs it when it also drops its DB; a normal dev stack keeps its paused
   sandboxes by design). Prod can never prove those sandboxes dead, so they are
   permanent. Not fixed here (see Solution).

Siblings found on the same ladder rung: superseded Temporal-retry task rows
(never closed when their attempt ended), 103 ACTIVE sessions whose tasks were
closed without a closeReason by the pre-a3f8dd421 bare-kill path (legacy
residue; resumable, now covered by the TTL sweep).

## Solution

- `agentStatusService.updateAgentStatus` now also releases the agent's code
  tasks on its first terminal transition (root or child): persistent sessions
  are checkpointed and paused through `closeClaudeCodeSession`, one-shot
  sandboxes are killed. Failure is logged; the reconciler retries.
- `agentCleanup.reconcileTerminalAgentCodeSessions`: bounded (batch <= 500,
  50 s deadline), per-agent failure isolation, discovers ACTIVE tasks of
  COMPLETED/FAILED/OUT_OF_CREDITS/COST_LIMIT_REACHED or archived agents. It runs
  inside the existing leased terminal-release cron
  (`runTerminalAgentBrowserReleaseReconcileWithLease`), one replica per tick.
- `lifecycle.sweepAllExpiredCodeSessions(limit = 20)`: the same retire path
  (kill sandbox, delete checkpoints, mark RETIRED) across all users, oldest
  first, run on the same lease. `findExpiredCodeSessions(userId | null)`.
- 10k agents: one lookup per terminal agent (indexed by agent), a bounded
  scan per cron tick (<= 500 agents, <= 20 expired sessions), no per-live-agent
  work, one lease row.

Not done (approval/decision items): one-time reap of existing orphans (dry-run
criteria in the delegation report) and whether a prod-side reaper may kill
`host:`-origin sandboxes older than N days (it would touch other stacks).

Verification: `cd back-end && bash scripts/run-blackbox-tests.sh agents` ran the
four new cases in `agents-terminal-code-release.cases.ts` and failed pre-fix
(`Terminal COMPLETED left the code task ACTIVE (status=ACTIVE); its sandbox is
never released`, `there is no durable retry for code tasks of terminal agents`),
then passed unchanged post-fix; `... code-sessions` passes with the new
`the scheduled TTL sweep retires expired sessions of users who never spawn
again` case. The TTL case was not executed pre-fix (the export did not exist).

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Every terminal path of an agent (completion, failure, deletion, cutover) must release every rental it owns through one shared release, and any idle-retention window needs a scheduled global sweep, not an opportunistic per-user one.
