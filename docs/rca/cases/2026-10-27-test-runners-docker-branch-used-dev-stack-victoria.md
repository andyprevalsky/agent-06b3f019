---
id: 2026-10-27-test-runners-docker-branch-used-dev-stack-victoria
date: 2026-10-27
title: Coverage and blackbox runners ran tests in the workspace container's dev-stack victoria database instead of victoria_<workspace>
surface: back-end
component: blackbox-coverage-runners
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/run-coverage.sh and run-blackbox-tests.sh Docker-container branches left LOCAL_PSQL_URL/SELECTED_DB_URL unset, so the default postgresql://…:<port>/victoria (the run.sh dev database) was used
symptoms:
  - "The input did not match the regular expression /^\\/victoria_[\\w-]+$/. Input: '/victoria'"
  - backend coverage browser-session and browser-world-state FAIL on a box whose workspace DB is a Docker container
tags:
  - blackbox
  - coverage
  - postgres
  - docker
  - test-isolation
sources:
  - commit febfd1916
  - commit 70cdf7778
repro: back-end/src/tests/blackbox/browser-session-lazy-retirement.cases.ts
status: fixed
---

## Problem

During /deploy of fix/mobile-pwa-chrome, Step 4a backend coverage failed two
domains, `browser-session` and `browser-world-state`. Both failed with:
`AssertionError: The input did not match the regular expression
/^\/victoria_[\w-]+$/. Input: '/victoria'`. Results: `229 passed, 2 failed,
231 total`.

## Diagnosis

The custody fixtures (since febfd1916) require an isolated
`victoria_<workspace>` test database. On system Postgres both runners select
`workspace_system_db_name`. This devbox had Docker, so run.sh created the
workspace container `victoria-db-cloud-f6ee74eb` and seeded the dev stack's
`victoria` inside it. The runners' Docker branches only set the port, so
`LOCAL_PSQL_URL` and `SELECTED_DB_URL` fell back to `…/victoria`. Coverage
then ran `prisma db push --accept-data-loss` and its fixtures against the
developer's seeded dev database. The guard caught the shared database, so the
guard was right and the runners were wrong. This is a relative of
2026-07-13-local-test-db-resolver-fails-open-to-shared-postgres. That case
covered the same "never the dev database" invariant on the system-Postgres
path only.

## Solution

Both runners' Docker-container branches now create and select
`victoria_<workspace>` inside the owned container. The coverage runner does
this through `use_workspace_container_db`; the blackbox runner does it inline,
mirroring its system-Postgres fallback. An existing-backend blackbox run still
uses the stack database, because its backend reads it.
`scripts/local-db-container.test.sh` (backend structural) asserts the wiring.
The custody guards remain the behavioral regression: before the fix both
domains failed in coverage. After it, `bash scripts/run-blackbox-tests.sh
browser-session` and `… browser-world-state` each report `1 passed, 0 failed`
against `database victoria_cloud-f6ee74eb`.

## Human feedback

None recorded.

## Reusable lesson

Every test-runner database branch, Docker or system, must select the
workspace's own test database and never the dev stack's victoria.
