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
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts (stop-command case only; reuse not implemented)
status: open
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

Not fixed: open. Making the contract true means a resume must reattach to a
healthy live ws-server and CLI, delivering the new spawn's goal as a direct-chat
user turn, instead of starting a new ws-server with `--resume`. That touches the
ws-server startup and direct-chat path, the agents attach path and the
LLM-visible delivery of the goal. It crosses cluster boundaries and is
approval-gated, so it was not built in T3's budget.

Interim: the config.py comment now states the real contract. Files, commits and
the conversation (`--resume`) carry over; background shells and pending waits of
the paused CLI do not.

Golden reference: not applicable yet (no approval-gated hunk built).

## Human feedback

None recorded.

## Reusable lesson

Before restarting a process tree on resume, check whether the paused tree is still healthy; a platform that preserves processes is useless if our own resume path kills them.
