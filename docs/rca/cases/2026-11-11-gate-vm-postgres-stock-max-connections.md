---
id: 2026-11-11-gate-vm-postgres-stock-max-connections
date: 2026-11-11
title: The Blacksmith gate VM ran PostgreSQL's stock max_connections=100, so sharded backend coverage pools were refused mid-gate
surface: harness
component: deploy-gate-setup
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/ci/deploy-gate-setup.sh "postgres" step started PostgreSQL 16 with the runner image's stock max_connections=100, while every devbox runs 300 (scripts/cloud-build.sh) and backend-coverage-blackbox's two blackbox shards plus the unit pass each open their own Prisma pools (run-coverage.sh connection_limit=16) beside test-spawned child processes
symptoms:
  - "Too many database connections opened: FATAL: sorry, too many clients already"
  - "Prisma Accelerate has built-in connection pooling to prevent such errors"
  - "Lantern refreshable credentials: encrypted tenant-bound upload and serialized rotation -- Expected values to be strictly equal"
  - "expected 503 got undefined (LANTERN_REFRESH_IN_PROGRESS child)"
  - "backend-coverage-blackbox FLAKY on Blacksmith, passes on rerun"
tags:
  - blacksmith
  - deploy-gates
  - postgres
  - max-connections
  - backend-coverage
  - flaky
sources:
  - PR #1932 gate backend-coverage-blackbox FLAKY ae9ae00ce96e4ceeb75d46cc9f1fa0c2 on source 3da522eb56aa (GitHub Actions run 43054793067); quarantined in 47745e800, merged ab95cc790
  - PR #1947 backend-unit repair (thread ph78s205f09d6ehkw33vdj12ss8j0tsn) hit the same refusal; measured cap 100 / peak 79 clients on gate run 42694223937
  - commit f76adfe10 (branch fix/gate-vm-postgres-max-connections)
repro: on a host Postgres set to max_connections=100, hold 90 idle client connections (the concurrent shard pools; the gate sweep measured a 94-client peak) and run `cd back-end && bash scripts/run-blackbox-tests.sh integrations` → 49 FAIL with "sorry, too many clients already", Lantern included, exit 1; the identical command at 300 → 1 passed, exit 0 (peak 120 clients); regression `python3 scripts/tests/deploy-test-github.test.py GateSetupPostgres` (deploy structural gate deploy-test-github)
status: fixed
---

## Problem

`backend-coverage-blackbox` on a Blacksmith `deploy-gates` VM reported the integrations domain FLAKY: the Lantern small-pool child (`integrations.lantern-pool.cases.ts` `testLanternSmallPool`, `DB_CONNECTION_LIMIT=1`) got Prisma `Too many database connections opened: FATAL: sorry, too many clients already` from the VM's local Postgres. Its assertion then saw an error without `status` ("expected 503 got undefined"). The rerun passed, and the case was quarantined NOT_INTRODUCED in PR #1932. The repair thread for PR #1947's backend units hit the same refusal on the same gate independently.

## Diagnosis

Gate: NOT_INTRODUCED (no Lantern or database code changed). The refusal is a server-wide ceiling, not the Lantern logic. `scripts/ci/deploy-gate-setup.sh` claims to mirror the devbox toolchain but only started the runner's PostgreSQL 16 (`systemctl start postgresql`). It never changed `max_connections`, so the gate ran the stock 100. Every devbox gets 300 from `scripts/cloud-build.sh`, whose comment names this exact error. No other script configures the value (`grep max_connections` over scripts, back-end/scripts and .github).

Demand on the gate: `npm run test:coverage:sharded` runs two blackbox shards and the unit pass at once. Each process uses a Prisma pool bounded at 16 (`run-coverage.sh`), and tests spawn their own child clients. On this 8-vCPU devbox the full sweep at cap 100 peaked at 94 clients within its first three minutes. It passed that time, so the failure depends on timing. The integrations domain alone peaks at 28 clients. The sibling thread measured a 79-client peak on the gate VM. Every Prisma connect that lands while the server is full fails, and the Lantern child just happened to be the one that connected at that moment on the gate.

Local fail/pass on the same server, same command (`cd back-end && bash scripts/run-blackbox-tests.sh integrations`) with 90 idle clients held to stand in for the concurrent shards:
- max_connections=100: 49 FAIL, all `sorry, too many clients already` (Lantern refreshable credentials included), exit 1.
- max_connections=300 (the fix's value): 1 passed, exit 0, no refusals, peak 120 clients. That peak is above the stock ceiling, so the demand is real. Five more consecutive loaded runs at 300 also passed.

## Solution

`scripts/ci/deploy-gate-setup.sh` now writes `max_connections = 300` into `/etc/postgresql/$PG_MAJOR/main/postgresql.conf` before it restarts the server (a plain `start` would leave an already-running server on 100). It then reads `SHOW max_connections` from the live server and fails setup unless it is exactly 300. This gives the VM the devbox's ceiling, so gate results no longer depend on how the shard pools' connects happen to line up. The Lantern quarantine marker from 47745e800 is removed and the case blocks again. The assertions, timeouts, pool limits and concurrency are unchanged. The regression `GateSetupPostgres` in `scripts/tests/deploy-test-github.test.py` runs the real step with stand-in sudo/systemctl/psql. It proves the config is written before the restart, that setup fails when the server keeps 100, and that the value matches `cloud-build.sh`. It fails 2/2 against the old script. The fix also covers the backend-unit refusals in the PR #1947 repair, which carries identical bytes. It affects only test infrastructure, so 10k-agent production behavior is unchanged.

## Human feedback

None recorded.

## Reusable lesson

When a CI runner "mirrors" the devbox, diff every server setting the devbox provisioner changes (here Postgres max_connections) and verify the live value on the runner, because a stock default that is just under the gate's peak demand fails intermittently and looks like test flakiness.
