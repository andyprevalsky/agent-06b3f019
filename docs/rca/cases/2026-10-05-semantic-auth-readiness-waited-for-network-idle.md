---
id: 2026-10-05-semantic-auth-readiness-waited-for-network-idle
date: 2026-10-05
title: Authenticated semantic readiness waited for unrelated network quiescence
surface: harness
component: semantic-session-helper
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the shared semantic session helper consumed the global test budget waiting for networkidle despite active app traffic
symptoms:
  - Test timeout of 180000ms exceeded
  - browser chip count never reached 1
  - networkidle readiness delayed correct realtime bubble and ownership assertions
tags:
  - semantic
  - readiness
  - playwright
  - timeout
sources:
  - commit 7695d9bd9819c6c8bf3d87ce9c039e3c5535a5a4
repro: front-end/scripts/run-semantic-tests.sh
status: fixed
---

## Problem

The requested deploy's actual eight-test UI suite passed five and failed three:
realtime messages, browser chip count, and browser ownership. Private traces
retain the exact operations and results; the original failure earns no credit.

## Diagnosis

The shared injected-session helper reloaded at domcontentloaded, then awaited
networkidle and swallowed its timeout before verifying the session. Realtime and
ownership cases spent 74.7 and 85.1 seconds in that prerequisite while the app
continued dev-log and agent-read traffic; those traces contain no HTTP 5xx.
The realtime probe eventually returned five bubbles, satisfying its threshold,
but began its actual assertion after the global 180-second deadline. The chip
probe returned the expected one after the deadline; earlier transitions passed.
The ownership trace continued through its behavioral assertions after timeout.
These values do not prove every later assertion passed in the rejected runs.

Archive searches considered renderer stalls and shared-Prisma startup races.
Neither establishes this occurrence's host cause. Network quiescence was an
unnecessary prerequisite for the actual session and visible UI contracts.

## Solution

Remove only the networkidle wait. Retain injected-session validation, all eight
semantic tests, every UI count, final hydration/deduplication and ownership
assertion, and existing deadlines. The same complete command passed eight of
eight in 24.4 seconds afterward, with the same effective three workers. This is a test helper change, with no product code, prompt,
scoring, model, benchmark task, or normal execution-timeout changes.

The existing complete semantic suite already runs in local and production
deploy; no suite or verification stage was added. Frontend coverage passed
148 files and 2624 tests with three existing skips and unchanged thresholds.
Private paired evidence and independent review are under
`.context/deploy-runs/pr1410-finalize-20261005/`. Original traces remain private.

## Human feedback

The user requested removing unnecessary rejection signals, generous infrastructure
observation, and compact regression coverage cemented in deploy.

## Reusable lesson

Assert authenticated state and visible behavior directly instead of waiting for a realtime application to become network-idle.
