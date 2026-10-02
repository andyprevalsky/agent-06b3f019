---
id: 2026-09-30-semantic-runner-loses-stack-database-port
date: 2026-09-30
title: Fresh semantic runner seeded a different Postgres database than the active stack
surface: harness
component: front-end/scripts/run-semantic-tests.sh
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/scripts/run-semantic-tests.sh::apply_local_semantic_db_urls only read LOCAL_DB_PORT from its own shell and ignored the active run.sh services manifest
symptoms:
  - 'The column BrowserSession.kernelProxySource does not exist in the current database.'
  - 'PrismaClientKnownRequestError P2022 in seed-browser-take-control-e2e.ts'
  - 'browser-take-control semantic test failed while other seven UI specs passed'
tags:
  - semantic
  - take-control
  - local-db-port
  - deploy
  - postgres
sources:
  - PR #1344
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

The local `/deploy` stack served its backend on port 55170 and its Postgres on
55175. A separate semantic command launched in a fresh shell with
`BACKEND_PORT=55170` but no `LOCAL_DB_PORT`. Seven UI specs passed; the
`browser-take-control` setup failed before opening the UI. Prisma reported
`P2022` because `BrowserSession.kernelProxySource` was absent from the database
that the seed script reached. The active stack database did contain that column.

The failing run is `.context/deploy-runs/20260930-235404-20524/logs/semantic-20261001-005520-84777.log`.

## Diagnosis

Critical path: `run.sh` writes the stack's actual backend and database ports to
`.context/services.json` → `/deploy` invokes the semantic runner in a new shell
→ `apply_local_semantic_db_urls` has no inherited `LOCAL_DB_PORT` and exports no
URL → the take-control spec defaults to localhost:5432 → its seed writes to a
different database than the backend uses. The active `victoria` database at
55175 had the new column; the database reached by the test did not. The first
bad boundary is the runner dropping the stack's database identity when it
crosses into a fresh process.

Archive searches: `BrowserSession.kernelProxySource does not exist semantic
take-control P2022` and `fresh semantic shell missing LOCAL_DB_PORT seeds wrong
Postgres database`. The closest case,
`2026-09-09-deploy-local-db-port-ignores-system-postgres`, fixed the wrong port
advertised *inside* the stack environment for system Postgres. This incident
is a relative: the port was correct in the stack, but unavailable to the
separate semantic shell. Its existing `LOCAL_DB_PORT` test did not exercise a
missing variable with a live stack manifest.

## Solution

When `LOCAL_DB_PORT` is absent, the semantic runner reads the database runtime
port from `run.sh`'s running service manifest, but only if that manifest's backend
URL matches the backend under test. An explicit caller database URL or port takes
precedence. A missing, stopped, mismatched, or malformed manifest now fails
before Playwright instead of silently choosing localhost:5432. This uses the
stack's actual Docker or system Postgres choice instead of deriving a Docker
port from `BACKEND_PORT`.

The permanent deploy structural regression extracts the real runner function
and checks matching, mismatched, system Postgres, stopped and malformed manifest
cases, plus explicit caller overrides. With the old runner
at `.context/semantic-runner-under-test.sh`, this exact command exited 1 with
`FAIL: semantic runner must read the active stack database port`:

```sh
SEMANTIC_RUNNER_OVERRIDE="$PWD/.context/semantic-runner-under-test.sh" bash scripts/tests/semantic-deploy-gate.test.sh
```

After replacing that file with the fixed runner, the identical command exited
0 with `All semantic deploy gate checks passed`. The focused unchanged
`browser-take-control` Playwright spec passed (1/1, 18.4s), then the complete
local semantic gate passed eight UI specs and five latency checks. The structural
suite is run by `/deploy` Step 4s on every deploy.

No production route changes. The extra manifest lookup occurs once per local
semantic invocation.

## Human feedback

None recorded.

## Reusable lesson

Carry the active stack's database identity across fresh test shells through its manifest, and fail closed when the identity cannot be proven.
