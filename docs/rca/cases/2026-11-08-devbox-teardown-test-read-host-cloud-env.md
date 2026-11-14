---
id: 2026-11-08-devbox-teardown-test-read-host-cloud-env
date: 2026-11-08
title: devbox-teardown test ran the real script in the host checkout, whose .cloud-env re-exported ROSE_USE_SYSTEM_PG=true and broke the Docker case on every devbox
surface: harness
component: devbox-teardown
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/devbox-teardown.test.sh ran "$ROOT/scripts/devbox-teardown.sh" from the host checkout; the script sources "$ROOT/.cloud-env" after the test's `unset ROSE_USE_SYSTEM_PG`, so a devbox's cloud identity chose system Postgres for the Docker case
symptoms:
  - "FAIL: docker devbox must use the container port: DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:5432/victoria"
  - "devbox-teardown exit=1"
  - "FAIL: default is system Postgres: DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:5432/cli_nov05_deploy_command_structural"
tags:
  - devbox-teardown
  - cloud-env
  - rose-use-system-pg
  - deploy-command-structural
  - hermetic-test
sources:
  - PR #1762 repair devbox (2026-11-08), local run of python3 scripts/run-deploy-structural-gates.py --max-workers 4 on main 4a0e080d7
  - commit 02eb65acf1 (earlier fix that unset an exported ROSE_USE_SYSTEM_PG but not the one .cloud-env re-exports)
  - commit 3f453cf3f0 (main's equivalent fix, which shipped)
  - commit dcc2ff37e6be5593036be6dbafdb092d4a1d6be8
repro: bash scripts/tests/devbox-teardown.test.sh in a checkout whose .cloud-env exports ROSE_USE_SYSTEM_PG=true (every cloud-init devbox)
status: fixed
---

## Problem

On the repair devbox, the full structural registry reported `devbox-teardown exit=1`. A standalone run printed
`FAIL: docker devbox must use the container port: DB_URL_FOR_STACK=postgresql://postgres:postgres@localhost:5432/victoria`.
The same suite passes on Blacksmith runners.

## Diagnosis

`scripts/devbox-teardown.sh` runs in the devbox being destroyed and sources `$ROOT/.cloud-env` to get the workspace identity; that is
correct production behavior. The test invoked the real script in the host checkout. On a cloud-init devbox, `.cloud-env` contains
`export ROSE_USE_SYSTEM_PG=true`, so the test's `unset ROSE_USE_SYSTEM_PG` (commit 02eb65acf1) was undone inside the script. The
Docker case then took the system-Postgres branch and printed port 5432 instead of the fake container's 55441. Blacksmith has no
`.cloud-env`, which is why it passed there. Red: the unchanged test fails on this devbox, rc=1, with the message above.

## Solution

The test runs the real script from `$WORK/checkout/<checkout basename>`, a view with `scripts` and `back-end` symlinked from the
checkout and no `.cloud-env`. The script's own `ROOT` resolves to that view, so the host's cloud identity cannot decide the cases, while
the code under test and every assertion are unchanged. Green: 5 consecutive passes, plus one pass with `.cloud-env` sourced and
`ROSE_USE_SYSTEM_PG=true` exported in the calling shell. Not agent-scaled (test only).

Shipped fix: main landed an equivalent change concurrently, commit 3f453cf3f0 ("run the teardown from a root without the devbox .cloud-env"). It copies the three files the script reads into a fixture root instead of symlinking the checkout. PR #1783 adopted main's version when it synced, so this case records the diagnosis and the devbox reproduction. The merged fix is 3f453cf3f0, and `bash scripts/tests/devbox-teardown.test.sh` passes on this devbox with it.

## Human feedback

None recorded.

## Reusable lesson

A test of a script that sources files from its own checkout must run it from a fixture checkout, because unsetting a variable in the test cannot stop the script from re-reading the host's copy.


## Recurrence — fixture inherited the enclosing workspace and database pin (2026-11-09)

Full54's native devbox-teardown job exited 1 after 4.4 seconds. The preserved
log reports `FAIL: default is system Postgres` with database
`cli_nov05_deploy_command_structural`. The exact case environment explicitly
sets ROSE_SYSTEM_PG_DB_NAME to that value and CONDUCTOR_WORKSPACE_NAME to
cli-nov05-deploy-command-structural. These values belong to the enclosing
structural worker, not the fixture's copied root. The earlier fix removed the
host .cloud-env file but did not isolate inherited workspace/database variables.

The real workspace_system_pg_db_name correctly honors the explicit database
pin. With that pin absent, named workspaces correctly get distinct
victoria_stack_<workspace> databases; reverting that isolation would be the
wrong fix. The fixture's existing default/system/Docker cases expect the known
fake database victoria and derive their fake Docker container from the fixture
root. Give those cases an explicit fixture workspace, database and system port.
All original assertions, fake npx/docker bodies and timeout bounds remain intact.
Add two unpinned named-workspace cases that assert separate stack and killer
URLs, plus an invalid explicit-name case that must stop before backend dispatch.

Gate: NOT_INTRODUCED by dcc2ff37 relative to ec431bc5: all four test/runtime
inputs are byte-identical across those revisions. This is a recurrence of the
same fixture/environment isolation defect, not a database runtime failure.
The exact original command and captured relevant native environment reproduce
exit 1 on the original fixture and pass after the fixture-only repair. The
unchanged offline local-db-container tests and direct pure name-selection
controls preserve per-workspace isolation and shared-database refusal. No real
Postgres, provider, service or financial action runs; npx/docker/psql calls are
fake in these tests. The protected databases are untouched.

Evidence, hashes, full red/green logs and exact commands are retained in
.context/cli-nov09-teardown-rca/result.json. The original full54 failure remains
history and this focused repair grants no full registry or deployment credit.
The bounded scratch-only/no-real-database restrictions are operational parent
instructions, not a new direct user quote about product policy.
