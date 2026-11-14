---
id: 2026-11-08-code-session-close-checkpoint-unbounded-held-the-lease
date: 2026-11-08
title: Code-session close downloaded an over-cap checkpoint unbounded, so the worker timed out without the handoff and the lease stayed held
surface: back-end
component: code-session-close
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: back-end/src/providers/codeSessions/checkpoint.ts createCheckpoint read the whole worktree tarball (sandboxFs.readFile, E2B default 60 s request timeout) before checking the 200 MiB cap, and e2bCloseSession.ts released the lease (markPaused) only after that checkpoint
symptoms:
  - "[ClaudeCode] Failed to close session" error=ReadTimeout
  - "Code session checkpoint failed" reason=close error="The operation was aborted due to timeout"
  - "CodeSessionUnavailable: Failed to create code session (provider=claude): HTTP 409: {\"error\":\"Code session ... is in use by another code agent\",\"code\":\"CODE_SESSION_BUSY\"}"
  - "Code-agent verifier off. Returning session result as-is (provider=claude, exit_code=0, artifacts=0). Required output artifacts were not completely extracted - incomplete."
tags:
  - claude-code
  - e2b
  - code-sessions
  - checkpoint
sources:
  - agent 0874662a-afaf-4d24-b411-af99649108ad
  - task e6161c88-9577-42aa-92eb-64d49b3ce01f (code session 2256e1eb, sandbox i0q5ydf1i07gskstmqr2y)
repro: back-end/src/tests/blackbox/code-sessions-checkpoint-size.cases.ts
status: fixed
---

## Problem

Root agent 0874662a (prod, 2026-11-08). The first code agent's CLI exited at
03:54:33Z, but its result reached the parent only at 03:57:35. The worker's
close call timed out at 180 s (ReadTimeout). On Render, "Code session checkpoint
failed … aborted due to timeout" was logged at 03:58:03, then the pause. The
worker got no handoff, so a run that had answered was reported as FAILED. The
parent's immediate retry got 409 CODE_SESSION_BUSY because the lease was still
held. 100% of checkpoints on template 9l6o9vfkdxgocv6aybrj failed this way
(4 of 4 on Nov 8).

## Diagnosis

E2B disk metrics showed tar writing about 366 MB over about 140 s, then the disk
staying flat for about 60 s while the download ran until it hit the SDK default
`REQUEST_TIMEOUT_MS` (60 s, node_modules/e2b). Total: 206 s, more than the
worker's 180 s.

The 200 MiB cap was checked only after the download (checkpoint.ts:423-427), so
the archive would have been rejected anyway. The order in e2bCloseSession.ts
was: read the handoff, extract outputs, checkpoint, pause, `markPaused` (lease
release), then respond. So the timed-out worker received nothing.

A retried close of a CLOSED task returned `outputFiles: []` with no handoff
(e2bCloseSession.ts:192-194), so the handoff was lost for good. Local repro:
before the fix, the stalled-read case did not return within 10 s and the over-cap
case downloaded the archive. After the fix, close returned in about 3.2 s
against a 3 s budget.

## Solution

1. The tar step pipes through `head -c cap+1`, reports `WORKTREE_BYTES` and
   refuses an over-cap archive before any download.
2. The worktree read gets an explicit timeout based on its size.
3. Every checkpoint step honours a deadline at close start + 75 s
   (`CODE_SESSION_CLOSE_CHECKPOINT_BUDGET_MS`). A failed checkpoint still pauses
   the sandbox and calls `markPaused`, so the lease is always released.
4. The handoff and output file list are saved (closeRecord.ts, the code-session
   object store) before the checkpoint, and a retried close returns them.
5. Two blackbox cases cover the stalled read and the over-cap archive.

10k agents: per-session bounded work. One small write-once object per close;
no shared state.

## Human feedback

None recorded.

## Reusable lesson

Bound every step of a close path well inside its caller's timeout, release locks before optional work, and persist the result before anything that can stall.
