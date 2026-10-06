---
id: 2026-10-02-backend-coverage-rerun-erases-failed-run-backend-log
date: 2026-10-02
title: A host-wide stall failed the imessage coverage domain with P2028, and the rerun deleted the only backend log that could explain it
surface: harness
component: backend-coverage
classification: our-bug
problem_class: other
first_bad_boundary: back-end/scripts/run-coverage.sh — every run deletes coverage/blackbox-run and truncates coverage/server.log at startup, and the failure branch exited without printing or preserving either
symptoms:
  - "Transaction API error: Unable to start a transaction in the given time."
  - "delivery result -- failed send retries then success acknowledges -- Expected status 409, got 500"
  - "Backend log:     $BLACKBOX_ARTIFACT_DIR/backend.log"
tags:
  - backend-coverage
  - blackbox
  - p2028
  - deploy-gate
  - cloud-vm
  - evidence-preservation
sources:
  - PR #1341
repro: back-end/src/tests/unit/coverage-failure-evidence.test.ts
status: open
---

## Problem

`/deploy` Step 4a (deploy run `20261001-145844-51013`, stage log
`backend-coverage-blackbox-20261001-220259-795737.log`) on a 4-core Cursor Cloud
VM failed one of 167 backend blackbox domains. In imessage, the stale-claim
request in "delivery result -- failed send retries then success acknowledges"
returned 500 with `Transaction API error:
Unable to start a transaction in the given time.` after 46,066 ms. That is
`runTransactionWithRetry` failing to acquire a pool connection three times at the
15s `maxWait`. The next sequential case took 46,640 ms but passed.

The rerun of the same gate on the merged tree passed every domain. imessage took
2,952 ms, and its result requests took 5-11 ms.

## Diagnosis

Preliminary findings, not a completed RCA. The failed run's backend log cannot be
replayed because it no longer exists.

- **Not imessage code.** Across the eleven Step 4a runs in this deploy, the failed
  run is the only one where several unrelated domains grew together:

  | Domain | Normal | Failed run |
  | --- | --- | --- |
  | imessage | 0.6-3.0s | 94.5s |
  | data-real-user | 5-19s | 117s |
  | fast-cache | 8-23s | 111s |
  | agents | 290-333s | 459s |

  A ~90-130s stall hit the whole instrumented backend, and imessage was one victim.
- **The stall reached Postgres traffic.** The system Postgres log normally logs
  test-induced errors every few seconds. It logs nothing from 22:05:59 to 22:07:06
  UTC; the next entry is a timed checkpoint. There is no restart, connection-limit
  error, or OOM entry. `max_connections` is 300.
- **Ruled out:** the Step 4cb lane started at about 22:05:40, but its tests use fake
  `pg_dump`/`docker` binaries and never touch Postgres. The
  canonical-seed-whatsapp-content probe only runs `SELECT 1`. The same lane layout
  on 2026-10-02 did not stall.
- **Still open:** what stalled the host. The candidates are memory thrash (16 GB
  RAM, no swap, four coverage lanes plus tsc and ESLint at once), CPU starvation
  (worker budgets sized for a 14-core host running on 4 cores), or a lock held on
  a hot table. Telling them apart needs the backend's request timeline and the
  kernel's pressure-stall counters for the window. Neither was captured.
- **Why the evidence is gone:** the backend log is `coverage/server.log` and the
  runner artifacts are `coverage/blackbox-run`. Both are fixed paths, and the next
  coverage run truncates and deletes them before it starts. The failure branch
  exited without printing their paths. The only path the script ever printed,
  `$BLACKBOX_ARTIFACT_DIR/backend.log`, was never written, and it sat in an
  unreachable block after the failure branch had already exited.

## Solution

Close the evidence gap so the next occurrence can be classified:

- New helper `back-end/scripts/coverage-failure-evidence.sh`.
  - `record_host_pressure` appends cumulative PSI totals (`/proc/pressure/{cpu,memory,io}`),
    `MemAvailable`, and load average. `run-coverage.sh` calls it before the suites
    start and again on failure. The difference between the two snapshots shows
    which resource stalled.
  - `preserve_coverage_failure` copies `server.log` and every blackbox artifact
    into `.context/test-runs/backend-coverage-failed-<utc>-<pid>/`. The failure
    branch prints those paths. A later run cannot delete them.
- Removed the unreachable failure block and its nonexistent `backend.log` path.
- `back-end/src/tests/unit/coverage-failure-evidence.test.ts` runs the helper
  against fake run artifacts, deletes the fixed paths the way the next run does,
  and asserts the copies, PSI lines, and wiring survive. It fails on the previous
  revision: there the helper is missing, and with the helper added the wiring
  assertion fails. It runs in every Step 4a.

Cost at 10k agents: none. This is test harness code. A failed run copies one log
and its artifacts once, and each run writes two PSI snapshots.

Keep this case `open` until a captured occurrence (or a controlled replay of
the captured pressure profile) names the stalled resource and that cause is fixed.

## Human feedback

None recorded.

## Reusable lesson

When unrelated domains in one suite all slow down by the same amount, it is a
host or backend stall, not a domain bug. A rerun must never erase the only
evidence of a failure, so preserve it before rerunning and record the host's
pressure counters alongside it.
