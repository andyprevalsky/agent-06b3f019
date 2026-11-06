---
id: 2026-11-04-code-session-resume-treated-every-connect-error-as-sandbox-gone
date: 2026-11-04
title: Code-session resume treated every Sandbox.connect error as "sandbox gone" and replaced the paused sandbox from a possibly stale checkpoint
surface: back-end
component: code-session-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/lifecycle.ts connectPausedSandbox caught every error from Sandbox.connect and returned null
symptoms:
  - Paused sandbox could not be resumed; falling back to checkpoint
  - resumed_from checkpoint after an E2B 429 / 5xx / request timeout
  - work since the last checkpoint missing after a resume
  - orphaned paused E2B sandbox still holding the session's latest files
tags:
  - code-sessions
  - e2b
  - resume
  - error-classification
sources:
  - commit a3f8dd421c
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

`acquireCodeSessionSandbox` resumes a session's paused sandbox through
`connectPausedSandbox`. Any connect failure (429, 5xx, the SDK's default request
timeout) returned null, so the spawn created a new sandbox and restored the
latest checkpoint into it. The paused sandbox still held every change made after
that checkpoint. It was orphaned: the row was re-pointed to the new sandbox, so
nothing referenced the old one again, and E2B keeps a paused sandbox
indefinitely.

## Diagnosis

`lifecycle.ts:227-233` at base 28a7bfc99 had a blanket `catch → return null`. The
SDK maps a missing paused sandbox to `SandboxNotFoundError` (a 404 from
`connectSandbox`), and a live connect to a nonexistent id confirmed that class
on 2026-11-04. Every other failure is transient or unknown, and replacing the
sandbox on those loses data.

Repro (buggy base): `cd back-end && bash scripts/run-blackbox-tests.sh code-sessions`
→ `not ok 25 - resume: only a missing sandbox falls back to a new one; a transient E2B error never orphans the paused sandbox`.
The input did not match `/502/`: the actual error was `create must not run`,
because the transient error had fallen through to `create`.

Separately, the existing test `close checkpoints and pauses … a dead sandbox
falls back to the checkpoint` (and `code-session-resize`) simulated a dead
sandbox with a plain `Error('sandbox not found')`. That fixture did not match
real E2B behaviour, so it was changed to throw `SandboxNotFoundError`.

## Solution

`connectPausedSandbox` returns null only for `NotFoundError` (which covers
`SandboxNotFoundError`) and rethrows everything else. The spawn fails, and the
Temporal retry tries the same paused sandbox again instead of forking from an
older checkpoint.

10k agents: no new calls; one `instanceof` check per resume.

Post-fix: same command passes; 5/5 consecutive runs.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Only an explicit not-found from the provider may trigger "recreate from backup"; treat every other error as transient and retry the original resource.
