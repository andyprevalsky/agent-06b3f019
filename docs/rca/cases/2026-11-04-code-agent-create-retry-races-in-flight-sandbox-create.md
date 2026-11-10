---
id: 2026-11-04-code-agent-create-retry-races-in-flight-sandbox-create
date: 2026-11-04
title: A code-agent session-create retry after the 60s client timeout races the still-running first create, so one spawn starts several tasks and kills its own CLI
surface: cross
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/spawn.ts createWithCodeSession ran the full sandbox create for every request of one spawn (same tool-call lease owner), while agents/domains/spawn_claude_code_agent/repo.py create_e2b_session read for only 60s, so Temporal retried a create the backend was still running
symptoms:
  - "[ClaudeCode] Automation failed" error=ReadTimeout on "Creating E2B session", then attempt 2 and 3 of spawn_claude_code_activity
  - one spawn_agent(type=code) call shows three code-agent children "Read-only. In the Ro..." in the sidebar
  - "Restarting the code-session CLI on resume" for the same codeSessionId seconds after its previous task's "Session ready"
  - code agent "Process exited" 4s after start, output only "[Project] Running startup script for Rose", then "Task Incomplete"
  - two E2B sandboxes or ACTIVE ClaudeCodeSession rows for one code session after a slow create
tags:
  - claude-code
  - e2b
  - sandbox-leak
  - temporal-retry
  - idempotency
  - code-session
sources:
  - commit 28a7bfc99
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
repro: back-end/src/tests/blackbox/code-sessions-spawn-replay.cases.ts (code-sessions.blackbox.ts) and agents/tests/blackbox/spawn_claude_code_agent.blackbox.py test_session_create_outwaits_a_slow_backend_and_heartbeats
status: fixed
---

## Problem

2026-11-04 (preliminary, code only): `create_e2b_session` used a 60s httpx
timeout and sent no create-request id. A backend create that outlived it was
retried by Temporal with the same `lease_owner`, which resolves to the same
code session; the retry could start a second sandbox or stop the first
create's ws-server.

2026-11-06 recurrence, reproduced (prod root 1a3d495c "Rose Repo Status", user
Andy; FE https://www.roselabs.ai/?agent-id=1a3d495c-826c-4eca-afe0-382fcbf72e82).
One foreground `spawn_agent(type=code, task_name=rose_repo_status)` call
(toolu_01Dt3LaU11ViNtfGTtAHUNQG) produced three `ClaudeCodeSession` rows on
sandbox it9575l3txdpk8t8mybo1 within 33s: dd8ef6a8 (04:19:06, left ACTIVE),
9c3c19a0 (04:19:22, the task the worker attached to) and 631d4602 (04:19:39,
left ACTIVE). The sidebar listed all three as code-agent children. Worker logs
(ClickHouse fly_logs): attempt 1 at 04:16:34 and attempt 2 at 04:17:36 both
ended `[ClaudeCode] Automation failed error=ReadTimeout` after 60s; attempt 3
(04:18:39) got 9c3c19a0. Render logs: request 1 created a new sandbox and
restored the Rose project for ~140s (`Session ready: dd8ef6a8` at 04:19:06).
Requests 2 and 3 re-leased the same CodeSession (same owner
`tool:1a3d495c…:toolu_01Dt3…`) and waited on the shared create slot. Each then
attached to `paused_sandbox`, got `Code session turn acknowledged
status=rejected` from the previous task's ws-server (still in project startup)
and took `Restarting the code-session CLI on resume`, which kills that ws-server
and CLI. Request 3 killed dd8ef6a8; request 2 killed 9c3c19a0 4s after it
started (`Process exited`, output `[Project] Running startup script for Rose`),
so the attached task ended `Task Incomplete` with no handoff and the root
spawned a 4th code agent.

## Diagnosis

Path: agents activity → POST /api/claude-code-session/create →
createWithCodeSession → resolveSpawnCodeSession (lease) → createClaudeCodeSession
(shared create slot → acquire sandbox → attachLiveCodeCli / restart → task row).

1. Agents side: the 60s read is shorter than a normal create (a fresh repo
   sandbox restores its project for minutes; the create also waits up to 15 min
   for the shared E2B create slot), so a healthy create raises ReadTimeout and
   Temporal retries it while the backend keeps running it.
2. Backend (first bad data): the same tool-call lease owner re-leases by design,
   and nothing made the create itself idempotent per spawn, so every request ran
   the full create, wrote its own task row and restarted the CLI the previous
   request of the same spawn had started.
3. Why possible (rule 20, at-least-once activities): the create has a side
   effect (sandbox, CLI, task row) and no dedupe key, while the only stable
   per-spawn identity, the lease owner, was used for leasing only. The same gap
   hits any other activity retry of a spawn (worker crash before the session
   heartbeat lands, heartbeat timeout), not only timeouts.

Local repro (fails before, passes after, unchanged):
`CONDUCTOR_WORKSPACE_NAME=lanea CONDUCTOR_PORT=4710 bash back-end/scripts/run-blackbox-tests.sh code-sessions`.
Pre-fix: `not ok 21 - concurrent creates of one spawn start one task, and no retry
restarts its CLI: one spawn runs the sandbox create once 3 !== 1` and
`not ok 22 - a retry after the first create returned gets the same task`.
Agents: `test_session_create_outwaits_a_slow_backend_and_heartbeats` pre-fix
`AssertionError: {'connect': 60.0, 'read': 60.0, 'write': 60.0, 'pool': 60.0}`.

## Solution

Backend `createWithCodeSession` (shared by Claude Code and Codex) serializes
creates per tool-call lease owner (`tool:<agent>:<call>`) with the existing
cross-instance `withSerializedLock`, and stores the create response in
`SharedEphemeralState` (namespace `code-spawn-create`, 6h). A retried create
whose stored task is still ACTIVE on the same provider gets that task back and
never reaches the sandbox create, so it never restarts the live CLI. A closed
task (resize, usage-limit switch) or a failed first create is not replayed.
Agent-level owners (`agent:<id>`) are distinct spawns and are never replayed.
No schema change.

Agents `create_e2b_session` reads for the backend's own budget
(`CODE_SESSION_CREATE_TIMEOUT_S`, 30 min) and heartbeats every 30s while it
waits, so liveness stays the activity heartbeat and the heartbeat timeout never
starts a second attempt beside the first.

Verified end to end on a local stack (root 579592ee, repo attached, no Project): one
spawn, one create request, one task row, no retry, a message delivered to the live
CLI. A second, sequential path to the same symptom (the ws-server blocking on its
own clone) is its own case: 2026-11-06-ws-server-ready-while-clone-blocks-event-loop.

Siblings it prevents: duplicate tasks after a worker crash before the session
heartbeat lands; a heartbeat-timeout retry during a queued create; leaked
ACTIVE task rows that the sidebar lists and the composer cannot reach. Not
covered: the local Mac target (C14) sends no lease owner; its retry still
starts a second ws-server on the Mac.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

Orchestrator (2026-11-06): show that a retry reattaches and completes and that
the activity neither burns its retry budget nor fails on a ~150s create, using
the repo's heartbeat or poll patterns rather than only raising the timeout; and
cover in the regression that a duplicate request never kills the live CLI of
the same lease.

## Reusable lesson

Key every side-effecting create to the caller's stable retry identity and replay its result; a client timeout shorter than the server's work turns each retry into another resource.
