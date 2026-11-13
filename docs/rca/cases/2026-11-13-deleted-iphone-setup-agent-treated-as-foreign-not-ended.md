---
id: 2026-11-13-deleted-iphone-setup-agent-treated-as-foreign-not-ended
date: 2026-11-13
title: Owner-deleted iPhone setup agent 409'd the connection screen and Connect instead of ending setup
surface: back-end
component: iphone-connection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.connection.ts activeSetup()
symptoms:
  - "GET /api/iphone/connection 409 iPhone setup agent is unavailable"
  - "POST /api/iphone/connect 409 iPhone setup agent is unavailable"
  - Connect iPhone button disappears after deleting the iPhone setup agent; no way to reconnect
tags:
  - iphone
  - connect
  - soft-delete
sources:
  - agent 902ff679-05d1-51bb-ac5c-d2580aea4d23
repro: back-end/src/tests/blackbox/iphone-control.connection.cases.ts
status: fixed
---

## Problem

Prod 2026-11-13 06:27Z: the owner's iPhone connection reservation pointed at setup agent
902ff679-05d1-51bb-ac5c-d2580aea4d23, which the owner had soft-deleted (deletedAt
2026-11-12T15:46:24Z, status FAILED). Every `GET /api/iphone/connection` returned 409
`iPhone setup agent is unavailable`, the screen lost its Connect button, and
`POST /api/iphone/connect` hit the same 409, so no fresh setup could ever start.

## Diagnosis

`connection()` and `reserve()` (Connect) both call `activeSetup()` for the reserved agent.
It threw 409 when `agent.userId !== userId || agent.deletedAt !== null`, treating an
owner-deleted agent like a foreign one. Ownership is a security fence; deletion by the owner
is only the end of that setup, exactly like the `inactive` statuses (`PAUSED`, `FAILED`, ...)
that already return `false` so Connect reserves a new revision. The local blackbox repro
(soft-delete the reserved agent, GET /connection) failed with 409 before the fix.

## Solution

`activeSetup()` keeps the cross-user 409 and returns `false` for a deleted owned agent, so
the screen shows `not_connected` and Connect reserves a fresh setup actor on the same bound
device. Regression: "an owner-deleted setup agent ends setup ..." in the iphone-connection
blackbox suite (deleted predecessor → GET 200 + Connect 200 new agent; foreign agent → 409).
10k-agent behavior: unchanged, one indexed agent lookup per call.

## Human feedback

User insisted the cross-user guard stays (foreign-owner agent must still 409) and that no
other behavior changes; do not touch the live phone or call Connect in prod.

## Reusable lesson

Treat an owner soft-delete as a terminal lifecycle state, never as an ownership violation.
