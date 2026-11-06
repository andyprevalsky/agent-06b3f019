---
id: 2026-11-04-oauth-feedback-vm-omitted-event-emitter-contract
date: 2026-11-04
title: OAuth feedback VM server double omitted the newly used event-emitter contract
surface: harness
component: codex-oauth-feedback
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Real sliced ws-server producer registered listening but both VM WebSocketServer doubles had no on method
symptoms:
  - wss.on is not a function
  - Codex producer/worker feedback contract failed
  - codex-oauth-feedback.test.ts
tags:
  - codex
  - oauth
  - vm
  - websocket
  - fixture
sources:
  - commit 740988beb558d4879897cb3fbc4d2151d258d6b8
  - commit b9a1f743152e29cb6626ed33fdce88d24a919ba1
repro: node --import tsx back-end/src/tests/unit/codex-oauth-feedback.test.ts
status: open
---

## Problem

The retained b9 full backend unit run failed two of356files. All seven OAuth cases threw wss.on TypeError before their assertions. This failure is independent of the separate Prisma stale-client message and host memory-watchdog events.

## Diagnosis

Gate: INTRODUCED. Commit740988beb correctly moved readiness logging into the owned server listening event, but the existing OAuth VM double was an empty class. The VM executes the real producer slice containing that new registration. Baseline6f has no registration and the fixture itself is byte unchanged throughb9. The first-bad-parent extracted producer equals the b9 producer with only the three new registration lines removed. The exact owning wrapper fails7/7 onb9, passes7/7 with that single causal reversal, and passes7/7 after restoring exactb9 producer and repairing only the doubles. Logs and hashes are in report.json and source-comparison.json.

## Solution

Import the real Node EventEmitter and make both existing VM WebSocketServer doubles inherit it. All original formatter, quota/OAuth classification, fallback and actual worker-function assertions remain byte unchanged. No socket is opened; production readiness/ephemeral-port ownership remains intact. The existing registered unit wrapper permanently executes these cases. Private owning RED/GREEN is complete; parent integration and full current-source gate remain required, so this source case staysOPEN. Golden reference: not applicable (test-fixture-only, no approval-gated hunk).

## Human feedback

Parent required private-only repair with genuine owning RED/GREEN, preservation of the two original native failures, no assertion/time/concurrency relaxation, no application-source mutation, provider calls or full gate launch. Preserve Freedom. Parent retains source and deploy ownership.

## Reusable lesson

Match VM boundary doubles to the real dependency interface consumed by the exact extracted production code.
