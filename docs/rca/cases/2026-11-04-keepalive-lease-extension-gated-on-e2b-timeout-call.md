---
id: 2026-11-04-keepalive-lease-extension-gated-on-e2b-timeout-call
date: 2026-11-04
title: Code-session keepalive skipped the lease extension whenever the E2B setTimeout call failed
surface: back-end
component: code-session-keepalive
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/codeSessions/spawn.ts keepAliveCodeTask awaited Sandbox.setTimeout before extendLease, so a throw skipped the lease update
symptoms:
  - POST /api/claude-code-session/:taskId/keepalive 500
  - CodeSession leaseExpiresAt in the past while its CLI is still running
  - Code session is leased by another spawn; starting a parallel session
  - a second spawn takes the session and its resume kills the live CLI
tags:
  - code-sessions
  - lease
  - keepalive
  - e2b
sources:
  - commit a3f8dd421c
repro: back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

The attached activity calls keepalive every 120 s. At base 28a7bfc99,
`keepAliveCodeTask` awaited `setTimeoutFn` (E2B) first and extended the 1-hour
lease (`store.ts` LEASE_MS) only afterwards. While E2B's API failed (5xx or
request timeout), every keepalive threw before `extendLease`. After an hour the
lease of a session with a live CLI lapsed. Another spawn of the same owner could
then lease it, and its resume ran `stopStaleWsServer`, killing the live CLI.

## Diagnosis

Code order at spawn.ts:343-347 (base). Repro (buggy base):
`cd back-end && bash scripts/run-blackbox-tests.sh code-sessions` →
`not ok 23 - keepalive extends the session lease even when the E2B timeout call fails`
with `a failed E2B call must not let the lease lapse under a live CLI`
(expected true, actual false).

## Solution

The lease (a DB fact about the attached activity) is extended before the E2B
call, which can fail. The E2B error still propagates; it is not masked. The
resize check no longer runs inside the same closure as the lease.

10k agents: unchanged; the same per-session indexed update, done first.

Post-fix: same command passes; 5/5 consecutive runs.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

Renew a liveness lease from facts you own before calling the third party that can fail; a provider outage must not hand the resource to a second owner.
