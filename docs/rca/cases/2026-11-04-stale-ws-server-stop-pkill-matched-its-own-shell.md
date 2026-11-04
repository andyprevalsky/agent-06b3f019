---
id: 2026-11-04-stale-ws-server-stop-pkill-matched-its-own-shell
date: 2026-11-04
title: The resume's stale ws-server stop command was killed by its own pkill -f and never waited for the port
surface: back-end
component: code-session-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/e2bCodeSessionSandbox.ts stopStaleWsServer ran pkill -f 'node /home/user/ws-server.mjs' inside a bash -c whose own argv contains that pattern
symptoms:
  - Stopping the resumed sandbox ws-server failed error=signal: terminated
  - CommandExitError signal: terminated on resume
  - new ws-server EADDRINUSE on port 3000 after a resume
tags:
  - code-sessions
  - e2b
  - pkill
  - self-match
sources:
  - commit 34631aa2ab
  - memory:pgrep-self-match-waiter
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

Every resume of a paused sandbox runs `stopStaleWsServer`. Its command
(`pkill -f 'node /home/user/ws-server.mjs' || true; <wait for :3000 to close>`)
runs as `bash -c "<command>"`. That shell's argv contains the pattern, so pkill
SIGTERMs its own shell. The SDK raised `CommandExitError: signal: terminated`,
the code logged a warning, and the port wait never ran. The new ws-server
therefore raced the old one's shutdown for port 3000.

## Diagnosis

Live probe on real E2B, 2026-11-04: `stopStaleWsServer command error: signal: terminated`.
Local repro (buggy base):
`cd back-end && bash scripts/run-blackbox-tests.sh code-sessions` →
`not ok 28 - resuming a paused sandbox stops its stale ws-server without killing the stop command itself`
with `{ exitCode: -1, signal: 'SIGTERM' }` instead of `{ exitCode: 0, signal: null }`.
The final test version was re-run against the reverted fix and failed the same
way. Same class as the `pgrep -f` self-match waiter memory.

## Solution

Pattern `'[n]ode /home/user/ws-server.mjs'`: the regex still matches the
ws-server, but the literal text in the shell's own argv does not. The command now
completes and waits for the port.

The same bug existed in `sandboxResize.ts stopSandboxCli`, which runs
`for p in $(pgrep -f 'node …'); do … kill -TERM "$p"; done`. That list included
the command's own shell, which then killed itself. It is fixed the same way, and
case 32 (`the resize CLI stop does not kill its own shell`) failed before the fix
and passes after it.

10k agents: unchanged.

Post-fix: same command passes; 5/5 consecutive runs.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Never `pkill -f`/`pgrep -f` a literal pattern from inside a shell whose own command line contains it; use a `[x]` bracket pattern or a PID file.
