---
id: 2026-11-06-ws-server-ready-while-clone-blocks-event-loop
date: 2026-11-06
title: The sandbox ws-server cloned the repo synchronously after binding its port, so the backend called it ready while it could not answer, and the retries created more code agents and lost every message
surface: cross
component: claude-code-ws-server
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/e2bWsReady.ts isListening (netstat | grep :3000) declared the ws-server ready once its port was bound, while e2b-templates/claude-code/ws-server.mjs ran execSync("git clone") on its event loop after new WebSocketServer({port}); readiness meant "bound", the contract callers rely on is "serving"
symptoms:
  - "[ClaudeCode] Automation failed" error="Failed to connect to Claude Code WebSocket" 30s after "Session created"
  - "Code session turn delivery attempt failed" error="no user_turn_ack within 10000ms"
  - "[ClaudeCode] Previous sandbox unreachable; closing it before a fresh start"
  - "WebSocket server ready in 869ms" for a sandbox whose ws-server logged no "Server listening"
  - "Message delivery failed: Activity task failed" from send_message_to_agent to a just-spawned code agent
tags:
  - claude-code
  - e2b
  - ws-server
  - event-loop-blocking
  - readiness
  - git-clone
sources:
  - agent cab5bfbf-727a-4a5f-ac17-b028a924b0e7
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
repro: back-end/src/tests/blackbox/code-sessions-ws-startup.cases.ts (code-sessions.blackbox.ts)
status: fixed
---

## Problem

Found by the local-stack e2e of the C1/C3 fix (root cab5bfbf, user Andy, no
Project, goal naming https://github.com/Rose-Ai-Labs/rose; the prod incident root
1a3d495c had a Project and did not hit this). One background
`spawn_agent(type=code, task_name=rose_repo_status)` call (toolu_01V4x9sx…)
produced three `ClaudeCodeSession` rows 3be7cf6a, c4ab1910 and cd853537 on
sandbox idn49owkus7jvqqmeldxu, each CLOSED before the next was created, so the
sidebar listed three code agents for one spawn. The root's two
`send_message_to_agent` calls to /root/rose_repo_status failed with `Message
delivery failed: Activity task failed` (backend 502) and then `Code agent
session is not running` (backend 409).

Worker log: `Session created` 05:08:08, `Automation failed … Failed to connect to
Claude Code WebSocket` 05:08:38, retry, `Endpoint unreachable` x3, `Previous
sandbox unreachable; closing it before a fresh start`, new task at 05:09:44, the
same again, third task at 05:10:39 (this one connected and finished). Backend log:
`Session ready` 05:08:08 with `WebSocket server ready in 869ms`, then
`CodeSessionTurns … no user_turn_ack within 10000ms` for every turn. The
sandbox's /tmp/ws-server.log for the first task stops at `Configuration written`:
no `Starting Claude Code CLI`, no `Server listening`. The Rose `.git` in that
sandbox is 1.2 GB.

## Diagnosis

Path: backend create → `waitForSandboxWsServer` → agents activity WS connect →
turns over the same WS.

1. First bad data: `ws-server.mjs` constructed `new WebSocketServer({port})`
   (line 111, port bound) and then ran `execSync("git clone …")` (line 553) at
   module top level, on the event loop. The ws library only emits `listening`,
   accepts upgrades and reads frames from the event loop, so for the length of
   the clone the server could do none of them.
2. The backend's probe was `netstat -tln | grep :3000`: true as soon as the
   socket is bound. It returned ready after 869 ms.
3. The agents activity then could not complete a handshake (30 s connect
   timeout), failed, and its retry probed the sandbox, found it unreachable and
   did the designed recovery for a dead sandbox: close the task, create a new one.
   Each re-create resumed the same sandbox and `stopStaleWsServer` killed the
   ws-server that was still cloning, so the clone was interrupted too.
4. An interrupted `git clone` into /home/user/workspace left a repo without a
   commit; the next start took it for a resumable repo (`.git` exists) and logged
   `fatal: 'HEAD' is not a commit and a branch … cannot be created from it`, then
   `untracked working tree files would be overwritten by checkout: CLAUDE.md`.
5. Messages (backend `deliverToCodeAgent`) waited 10 s for a `user_turn_ack` that
   the blocked loop could not send: 502 "Could not reach the code agent session".

Why it was possible: "ready" was defined by the bound port, not by the server
answering, and the server did blocking work after binding. Siblings: a git fetch
in `prepareCodeSessionBranch` (synchronous, network) and the Codex ws-server's
readiness shared the same probe.

Local repro (fails before, passes after, unchanged): `CONDUCTOR_WORKSPACE_NAME=lanea
CONDUCTOR_PORT=4710 bash back-end/scripts/run-blackbox-tests.sh code-sessions`,
cases 24-26 and the duplicate-create case. Against the original ws-server:
`the event loop answers while the repo downloads: 'ready' !== 'cloning'` and
`timed out waiting for the clone to start`.

## Solution

ws-server (`e2b-templates/claude-code/ws-server.mjs`): the port is bound first by
an HTTP server that answers `GET /` with the typed startup state (503
`{state: "starting" | "cloning"}` until it serves, 200 `{state: "ready",
clone_ms}` after), and refuses WebSocket handshakes with 503 until then, so no
connection handler runs before the module state exists. The clone is
`cloneRepoAtomically`: an async `git clone` child into
`~/.workspace-cloning-<pid>` and an atomic rename into `~/workspace`, so an
interrupted clone leaves no workspace; stale temp dirs are removed at the next
start and a finished clone is reused (`RESUMING_REPO`). A signal during startup
stops the clone child and exits. The duration is a named startup phase (log
`Startup phase`, event `startup_phase`, and `clone_ms` on the ready answer).
`Server listening` (with its `readinessToken`, which the Mac runner and harnesses
read) is now logged when the server serves.

Backend (`e2bWsReady.ts`): one `curl` per poll tells `down` (refused, fail-fast
as before), `starting` (bound, not answering) and `cloning`/`ready` (typed)
apart; the wait has two bounds, `timeoutMs` for a dead server and a separate
configurable `startupBudgetMs` (CODE_AGENT_STARTUP_BUDGET_MS, default 10 min)
for a live one that is cloning. The create returns `startup: {ws_ready_ms,
clone_ms}`, which reaches the "Claude Code Started" row as
`code_agent.startup`. The create therefore waits for the clone while the agents
activity heartbeats, and a retried create waits on the same create
(createWithCodeSession) instead of closing and re-creating the sandbox.

Verification on the same local stack (no Project, same goal shape; root
579592ee-ef44-4388-b39c-e99fdc1af24f, FE http://localhost:3601/?agent-id=579592ee-ef44-4388-b39c-e99fdc1af24f):
the create waited for the clone (`WebSocket server ready in 175948ms (repo clone
173210ms)`), the worker logged one `Creating E2B session` and one `Session created`
(no retry), there is one `ClaudeCodeSession` row, five sends during the clone got
the truthful `Code agent session has not started yet; send again once it runs`,
the sixth was delivered, the code agent's transcript shows `[Agent → Claude]
[Message from /root …] … ALSO report how many entries the repository's top-level
directory has`, and its final handoff includes `git ls-tree origin/main --name-only
| wc -l` = 39. The measured 173 s clone is what the 10-minute
CODE_AGENT_STARTUP_BUDGET_MS default is sized against (about 3.4x).

Not changed: the clone URL and the remote it leaves behind (the token in
`origin`; deferred by the user), `prepareCodeSessionBranch`'s synchronous git
calls (still short; they show as `starting`), clone depth, and the ws-server
writing the code-agent prompt over the repo's tracked CLAUDE.md after a non-Project
clone (a "read-only" run therefore shows `+44 −1770 CLAUDE.md` in its diff).

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

Orchestrator (2026-11-06): own the ws-server clone block; truthful readiness
from the server answering with a distinct `cloning` state; clone off the event
loop into a temp dir with an atomic rename; a configurable measured budget, not a
raised WS_READY_TIMEOUT_MS; a retry during the clone waits on or reattaches to
the same sandbox; emit the clone duration as a named startup phase.

## Reusable lesson

Define readiness as the server answering a request, never as its port being bound, and keep blocking work off the event loop of a server that binds first.
