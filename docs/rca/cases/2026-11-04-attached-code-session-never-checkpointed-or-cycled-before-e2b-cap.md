---
id: 2026-11-04-attached-code-session-never-checkpointed-or-cycled-before-e2b-cap
date: 2026-11-04
title: An attached code session was checkpointed only on close and never cycled before E2B's continuous-runtime cap
surface: back-end
component: code-session-keepalive
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/spawn.ts keepAliveCodeTask only extended the E2B idle window (Sandbox.setTimeout 30 min) and the lease; nothing saved or cycled a sandbox that stays attached
symptoms:
  - multi-day code agent loses all work after an E2B incident or the 24h runtime cap
  - latestCheckpointSeq unchanged for the whole life of an attached session
  - resume restores a checkpoint from the last close (possibly day 0)
  - POST /api/claude-code-session/:taskId/checkpoint has no caller
  - Maximum time a sandbox can be kept alive is 24 hours
tags:
  - code-sessions
  - e2b
  - checkpoint
  - multi-day
  - runtime-cap
sources:
  - commit a3f8dd421c
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

Code agents have no runtime limit (C11) and are expected to run for days. A
session's checkpoints were written only on close, resize and provider switch.
The drain route `POST /checkpoint` (`routes.codeSessions.ts`,
`checkpointRunningTask`) has no caller in `agents/`. So any loss of an attached
sandbox (E2B incident, the continuous-runtime cap, a hard kill) rolled the
session back to its last close, possibly its creation.

E2B also caps one continuous run: 24 h on Pro, 1 h on Hobby (SDK typings). The
keepalive only called `Sandbox.setTimeout(30 min)`, which cannot extend past the
cap, and nothing paused and resumed the sandbox before it.

## Diagnosis

Evidence:
- The E2B docs, fetched 2026-11-04, say the cap resets after pause and resume,
  auto-pause persists across resume, and a paused sandbox is kept indefinitely.
- Live probe (one base sandbox, about 1 minute): `getInfo().startedAt` moved to
  the resume time, `lifecycle` stayed `{onTimeout:'pause'}` after `connect`, and a
  `sleep 600` process was alive after resume (`etimes` 8 s, so paused time is
  excluded). Cycling therefore keeps memory and processes and resets the cap.
- Code: `keepAliveCodeTask` (spawn.ts at base 28a7bfc99) only called
  `setTimeoutFn` and `extendLease`. `grep checkpoint agents/domains/spawn_claude_code_agent`
  finds no checkpoint call while attached.

Step 5a: the keepalive is the one periodic backend call per attached session. It
owned liveness but not durability. The deeper rung, "the session has no durable
state while running", is the same gap; the fix belongs at the keepalive.

Repro (buggy base): `cd back-end && bash scripts/run-blackbox-tests.sh code-sessions`
→ `not ok 24 - an attached session is checkpointed periodically and cycled (pause + resume) before the E2B runtime cap` — `expected: 1, actual: 0` (no periodic checkpoint).

## Solution

`keepAliveCodeTask` now calls `scheduleCodeSessionMaintenance` (lifecycle.ts) for
E2B sessions. When `CODE_SESSION_CHECKPOINT_INTERVAL_MINUTES` (default 30) has
passed since this backend's last save, a background job runs:
- It reads `Sandbox.getInfo().startedAt` and checkpoints through the held sandbox
  (reason `periodic`).
- When the current continuous run is within one hour of
  `E2B_SANDBOX_MAX_RUNTIME_HOURS` (default 24), it checkpoints with reason
  `runtime_cycle`. If the task is still ACTIVE, it then pauses and immediately
  resumes the same sandbox, which resets E2B's clock and keeps memory and
  processes. The attached activity's websocket reconnects as it does on any drop.

Siblings it also bounds: work lost to a cutover, deploy or kill path, and to an
E2B incident, is now at most one interval.

10k agents: one map entry per attached session on the instance that serves its
keepalives; at most four concurrent saves per instance, retried on the next
keepalive when saturated. First sight is jittered across one interval, so a
deploy restart does not checkpoint every session at once. Saves land at about
10k/30 min ≈ 5.5/s across the fleet, each one an in-sandbox tar plus one R2
upload. If several backend instances serve the same session's keepalives, each
keeps its own clock, so that session saves up to N× as often. That is safe
(`commitCheckpoint` only advances), only more frequent.

Post-fix: same command passes (`# pass 26`), 5/5 consecutive runs unchanged.

Open (not fixed here): the drain route remains callerless, and drain still
detaches without a checkpoint; periodic saves bound that loss to one interval.
Item 8 checkpoint-size limits (200 MB worktree cap throws on every attempt; the
CLI log is uploaded uncapped) are recorded in the T3 report as open.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A long-running resource with a provider runtime cap needs durability and renewal on its liveness heartbeat; saving only on close turns every unplanned loss into a rollback to the last close.
