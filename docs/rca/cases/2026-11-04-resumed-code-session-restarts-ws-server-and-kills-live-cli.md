---
id: 2026-11-04-resumed-code-session-restarts-ws-server-and-kills-live-cli
date: 2026-11-04
title: Resuming a paused code session restarts the sandbox ws-server, killing the paused CLI and every process it started
surface: back-end
component: code-session-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/e2bCodeSessionSandbox.ts acquireCodeSessionSandbox calls stopStaleWsServer on every paused_sandbox resume; ws-server's SIGTERM handler kills its CLI child (e2b-templates/claude-code/ws-server.mjs:322,341)
symptoms:
  - The loop process is gone.
  - background shell / Monitor / ScheduleWakeup wait does not survive a code-agent pause and resume
  - resumed code agent restarts the conversation with --resume instead of continuing its turn
  - config.py says paused processes keep their memory, so a Monitor / ScheduleWakeup wait continues
tags:
  - code-sessions
  - e2b
  - resume
  - ws-server
  - multi-day
sources:
  - agent c4eaace9 (parent live repro on 28a7bfc99; task d0dade88)
  - commit 34631aa2ab
  - agent c7fc277e (parent live repro on integration 81402aef0: resumed with 23/32 lines)
repro: back-end/src/tests/blackbox/code-sessions-live-resume.cases.ts (bash scripts/run-blackbox-tests.sh code-sessions); agents/tests/blackbox/code_sessions.blackbox.py::test_user_pause_then_resume_keeps_the_live_cli_and_its_running_loop
status: fixed
---

## Problem

`agents/domains/spawn_claude_code_agent/config.py` promised that a paused
session's processes keep their memory, so a Monitor / ScheduleWakeup wait
continues on resume. Parent live evidence on 2026-11-04: a code agent ran a
32×15 s foreground Bash loop, and the root was paused (task `closeReason=cancel`,
session PAUSED, `latestCheckpointSeq=1`). After resume, a new spawn resumed the
same session and found the loop process gone.

## Diagnosis

Attribution, live on real E2B with a mock tree (ws-server.mjs → CLI bash with
`trap 'kill 0' TERM` → loop; liveness by PID file and `kill -0`, because `pgrep -f`
self-matches):
- `before pause: ws=alive cli=alive loop=alive`
- `after resume (pause only): ws=alive cli=alive loop=alive`. The E2B pause and
  resume preserved the whole tree. A plain `sleep 600` survived as well (`etimes` 8 s).
- `after stopStaleWsServer: ws=dead cli=dead loop=dead`

The user-pause path (`close_e2b_session` → `closeClaudeCodeSession(reason=cancel)`)
only checkpoints and calls `sandbox.pause()`; it sends no signal. The kill comes
from the next spawn's resume: `stopStaleWsServer` pkills ws-server, whose SIGTERM
handler calls `cliChild.kill('SIGTERM')`, and the CLI takes its shells with it.
The pkill also killed its own shell; that sub-bug is fixed in
`2026-11-04-stale-ws-server-stop-pkill-matched-its-own-shell`.

## Solution

Fixed for Claude Code (T8, branch `fix/code-agent-resume-keeps-live-cli`);
Codex stays on the restart path (open, below). First bad boundary:
`acquireCodeSessionSandbox` decided "restart" for every paused-sandbox resume
before anyone asked whether the paused CLI could take the new goal.

- `acquireCodeSessionSandbox` no longer stops the ws-server on a same-size
  resume (a resize still stops it before its checkpoint: the session moves to
  a new sandbox, so a restart there is correct). The Codex create path stops
  it itself (the previous behaviour).
- New `attachLiveCodeCli` (e2bCodeSessionSandbox.ts), called by the Claude
  Code create path in e2b.ts on `paused_sandbox`: the spawn's goal
  (`Task:\n<goal>`, the first prompt's framing) goes to the live ws-server as
  an agent `user_turn` signed with the session's previous task token, with the
  spawn's model/effort/speed as `settings`, and `attach: {token: <new task
  token>, credential: {keys, digest}, config: {key: digest}}`. The decision is
  the ws-server's structured ack:
  - `delivered` / `duplicate` with `attached: true` → attach. No project
    restore, no ws-server start; the new task row names the same sandbox and
    wsUrl (`resumed_from: live_cli`, `history_events`). The in-flight turn,
    tools and background processes continue; the goal is merged into the
    running turn (Claude Code queues it, claude-code-src query.ts) or starts
    the next one.
  - anything else → `stopStaleWsServer` and the existing
    restart-with-`--resume` path: `session_ended` (stdin closed after an
    autonomous turn, CLI exited), `credential_changed`, `unsupported_settings`,
    `relay_paused` (the user holds the CLI in direct chat), `unreachable`, an
    ack without `attached` (a ws-server started before this deploy, which
    would skip the credential check and token adoption), or no previous Claude
    task on the sandbox.
- ws-server.mjs (Claude Code) `handleUserTurn`: validates `attach`; the
  credential env digest must equal the spawn's or nothing is written. After
  delivery it adopts the new task's token (direct chat and agent relays to the
  new task id reach the live CLI) and answers `attached: true`,
  `ignored_config` (start-time env the running CLI keeps: system prompt,
  branch envs, repo URL; logged by the backend, as Codex logs the overrides a
  running thread ignores) and `history_events` (events before the write).
- agents service.py: events before `history_events` are the earlier spawns'
  history. Their usage-limit / login-unusable events are not this run's, and
  logging and the transcript start at the goal turn; tools in flight and turn
  accounting still come from the whole replay.
- Turn id `spawn-<sha256(key)>`: the key is a tool-scoped lease owner
  (`tool:<agent>:<tool_call_id>`, the same on every retry of that call, so a
  retried create gets `duplicate`), else the new task id (`agent:<id>` is
  shared by every spawn of the agent).

When a restart is still required (and correct):
- the spawn's credential differs from the one the live CLI holds (T2 re-lease
  with a fresh token, pool rotation, refreshed OAuth access token, API key ↔
  OAuth, Fast Mode proxy base URLs that embed the task id): a running CLI
  cannot adopt a new env and the old lease may be released or revoked;
- the CLI already finished its autonomous turn (stdin closed);
- provider switch (C15): `switchCodeSessionProvider` kills the old sandbox;
- resize (C16): new sandbox restored from a checkpoint;
- `fresh_conversation`;
- target=local (Mac, C14) and the same-host local fallback: no E2B pause; the
  close ends the CLI, so `prepareLocalCodeSessionHome` + `--resume` is the
  only path (unchanged);
- Codex (open): its handoff `outputSchema` is bound to the first turn
  (`codex-code/ws-server.mjs` handoffTurnId), so an attached goal would get
  no or the wrong result schema. Needs a per-turn output schema first.

User tools (`sessionRunner.ts`) also acquire the sandbox and now leave a live
CLI running instead of killing it. T3's 23h runtime cycle
(`maintainCodeSession`, raw pause + connect) is unchanged.

Regressions (deploy path; these files select the `backend-blackbox` and
`agents-blackbox` lanes in full):
- `back-end/src/tests/blackbox/code-sessions-live-resume.cases.ts` (domain
  `code-sessions`): production ws-server, scripted CLI whose Bash tool loops
  over counter.txt, E2B pause = SIGSTOP of the tree. Resume → acquire →
  `attachLiveCodeCli`: the ws-server survives, the loop writes 1..120 once,
  goal and new-task relay reach the same CLI pid, a retried create is
  `duplicate`; two spawns without a tool lease owner each deliver; CLI
  finished → `session_ended`, changed credential → `credential_changed`, each
  stopping the stale ws-server with nothing delivered. Pre-fix: `resuming the
  sandbox must not stop the live ws-server` (actual false).
- `agents/tests/blackbox/code_sessions.blackbox.py`:
  `user_pause_resume_keeps_live_cli_and_loop` (real activity; user pause
  freezes the tree, the resumed spawn completes with 60/60 lines and one CLI
  run; pre-fix ws-server: relay to the new task id `unauthorized`) and
  `usage_limit_pause_resume_attach_ignores_old_limit` (without the history
  boundary the resumed spawn re-reports spawn 1's limit).
- Live E2B (one-off, 83 sandbox-seconds, sandbox killed): real pause 20 s +
  connect kept the ws-server pid, the loop was frozen while paused, the
  attach and the new-token relay were delivered over the public wss and the
  loop finished 1..120 in one CLI process.

10k agents: one indexed `findFirst` (ClaudeCodeSession.codeSessionId) and one
control-socket round trip per resumed spawn, scoped to that one session; the
adopted-token set holds one entry per resumed spawn of that sandbox; no shared
channel, lock or polling.

Golden reference: approval T8-LIVE-ATTACH, recorded in the T8 handoff.

## Human feedback

None recorded.

## Reusable lesson

Before restarting a process tree on resume, ask the live tree itself (a structured ack, not a heuristic) whether it can take the new work; a platform that preserves processes is useless if our own resume path kills them.
