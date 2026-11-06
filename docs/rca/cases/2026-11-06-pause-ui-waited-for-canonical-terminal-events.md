---
id: 2026-11-06-pause-ui-waited-for-canonical-terminal-events
date: 2026-11-06
title: Browser pause left the live chip and ACTIVE state visible until server confirmation
surface: front-end
component: terminal-agent-pause
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: useAgentActions.handlePauseAgent only set a button spinner; buildReturn and useTerminalDerivedState ignored pending pause intent
symptoms:
  - when pausing a browser agent, the fe should optimistically close the chip and transition its state
  - User paused the browser agent
  - Browser session paused; the same session continues when resumed
  - expected 'ACTIVE' to be 'PAUSED'
tags:
  - browser
  - optimistic-ui
  - pause
  - state-transition
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
  - commit 75d1b1df8f877f20a60cc5cf84cf0219e451715c
repro: front-end/src/tests/blackbox/terminal-hooks.blackbox.ts
status: fixed
---

## Problem

Pausing the browser left its live chip open and the owner visibly ACTIVE during
HTTP/worker cleanup. The production transcript for the reported agent has browser
task 6efcd1c4-1638-5b06-9b08-9b50cfe7d5e2, invocation
b6b38413-9002-4ad8-bfcd-10f699efdabf, initialized at 04:14:51.934Z. At
04:15:27.429Z it records "Browser session paused; the same session continues
when resumed"; at 04:15:27.998Z it records "User paused the browser agent" with
userPauseRequested=true. Both are explicit task_complete messages. Thus cleanup
ultimately published the correct terminal events; the defect is the frontend's
pending interval, not a failure to stop the worker. The original click timestamp
was not captured, so no production click-to-close latency is claimed.

The sanitized browser init and both terminal events are retained in
browser-pause-1a3d.fixture.json. Private runtime capture is in
.context/pause-rca/agent.json and runtime-logs.txt (not committed).

## Diagnosis

Critical path: Stop button -> composer owner -> handlePauseAgent -> POST
/api/agents/:id/pause -> DB PAUSED and Temporal signal -> browser cleanup ->
terminal transcript events -> computeActiveBrowserPanels -> live chip.

The backend updates the DB before signaling, and the captured cleanup declares
terminality correctly. The first missing transition is at the click owner:
handlePauseAgent set only isPausing, while buildReturn returned canonical ACTIVE
and useTerminalDerivedState derived visibility exclusively from transcript
terminal events. Network and cleanup delays were therefore exposed as continued
work. A global boolean also attached an old request's spinner to a newly selected
agent. This is a presentation contract defect; no runtime lifecycle semantics
need to change.

Archive searches: "User paused the browser agent" and "optimistic pause chip
state". This is a relative of
2026-10-26-background-pause-ending-dropped-session-id-and-paused-state, not a
recurrence: that incident lost persisted outcome/session identity; this record
has both. Read that case's Solution and Human feedback before choosing the fix.

Reproduction command (run from front-end):
`npx vitest run src/tests/blackbox/terminal-hooks.blackbox.ts -t 'optimistically closes'`.
Before the production fix, both deferred-HTTP 200/500 cases failed with
`AssertionError: expected 'ACTIVE' to be 'PAUSED'` on 75d1b1df8f. The identical
command/assertion passed after the fix (2/2). The complete owning blackbox file
also passed (41/41). Original outputs: .context/pause-rca/repro-before.log,
repro-after.log and focused.log. Tests exercise the real composed terminal hooks,
HTTP client and panel derivation with MSW holding the POST open. Canonical
transcript and server state remain unchanged while pending. Additional checks
cover failed-request restoration, selection changes and authoritative completion.

## Solution

Unify the presentation around existing pending-pause intent rather than append
synthetic terminal messages or create a second event stream. Scope that intent
by agent id and request token, deduplicate concurrent clicks, and retain accepted
intent through failed or stale refreshes until canonical PAUSED/terminal state
or an explicit successful resume reconciles it. While an ACTIVE/STARTING_UP selected owner is pausing, project its
view and selected sidebar status as PAUSED. A PAUSED owner hides live browser
panels immediately, even when transcript cleanup has not arrived. Keep the intent
through the existing detail refresh; release it only after authoritative reconciliation or a rejected POST,
revealing the latest canonical state. Authoritative completion outranks the
pending projection. Selection changes cannot inherit the old spinner/status.

The new tests live in the existing frontend blackbox runner, discovered by
vitest.config.ts's blackbox glob and executed through /deploy's complete
frontend-coverage-blackbox category. This is ordinary frontend state/UI code.
Golden reference: not applicable (no approval-gated hunk).

10k agents: a sparse map of this view's outstanding pause requests (not the
owned-agent roster), each with one token, and a constant-size selected projection. No new
polling, subscriptions, broadcasts, DB work, per-agent timers or network requests.
Existing panel reduction is unchanged and skipped entirely for a paused owner.

Independent managed reviewer ph7e7k5yr6jwhmakprzsb8x8w58hhr57 found refresh-failure
and concurrent-agent request ownership gaps in the first candidate. Both were
reproduced before repair (three failing cases) using
`npx vitest run src/tests/blackbox/terminal-hooks.blackbox.ts -t 'accepted pause|concurrent pause ownership'`.
The unchanged cases pass in the full owning suite after token-scoped reconciliation.
Original evidence: review-repro-before.log and review-repro-after2.log. Initial
candidate failures remain preserved, not rewritten as passes.

## Human feedback

The user explicitly requires optimistic chip closure and state transition on
pause, followed by completed /deploy; do not stop at diagnosis.

## Reusable lesson

Project pending lifecycle intent in the owning view immediately, scope it to its agent, and reconcile against canonical state without fabricating transcript events.
