---
id: 2026-09-30-mac-setup-shared-postgres-fallback
date: 2026-09-30
title: Failed Mac Docker setup redirected a workspace reset into shared Postgres
surface: infra
component: setup-db-platform-fallback
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: setup-db automatically selected shared system Postgres after an owned container readiness timeout
symptoms:
  - "Docker Postgres unavailable — falling back to system Postgres"
  - "Failed Mac Docker setup touched shared Postgres"
tags:
  - workspace-isolation
  - postgres
  - macos
  - setup-db
sources:
  - PR #1299
repro: scripts/tests/setup-db-concurrency.test.sh
status: fixed
---

## Problem

During deploy preparation, an invocation intended to create a new isolated Mac
workspace container timed out waiting for its PostgreSQL readiness. The script
then automatically selected localhost:5432/victoria and reset/seeded that shared
database. A completion message concealed the changed resource owner. That
system database is not an owned cleanup target; it must not be dropped or stopped.

## Diagnosis

Runtime setup output showed Docker creation, a readiness timeout, automatic
system fallback, schema reset and successful seeding. Native inventory showed
the intended container absent. The first bad boundary was the unconditional
fallback in `scripts/setup-db.sh`, before the destructive critical section.
The schema lock serialized writes but could not authorize the wrong resource.

Archive searches were `Docker Postgres unavailable falling back system Postgres
Mac` and `workspace database isolation setup reset`. The local benchmark runner
already restricted automatic system fallback to Linux; setup did not.

The permanent existing setup blackbox now drives the shipped script with a
Darwin platform, failed Docker creation and reachable shared PostgreSQL. Its
unchanged assertion failed because the historical script succeeded through
shared PostgreSQL. The failing path stubs both psql and createdb.
After the fix, the full ownership/concurrency suite passed with no shared-PG
access or schema/seed work in that case. All fixtures are hermetic.

## Solution

Refuse automatic system-Postgres setup after Docker failure unless the platform
is Linux. Preserve explicit system-PG selection and the Linux cloud fallback.
Coverage uses a newly created database inside the previously verified, exactly
owned test server, with its explicit local coverage URL. No shared server is
claimed as owned or included in cleanup. Independent review verified a safe
four-branch matrix: Mac automatic refusal, Linux automatic fallback, explicit
Mac system selection and successful Mac Docker setup. The initial container
readiness timeout itself remains unexplained.

## Human feedback

Inspect existing setup before reinstalling or resetting anything, and never
touch unrelated databases or processes. The setup invocation violated that
isolation intent; this repair prevents its automatic platform fallback.

## Reusable lesson

A successful setup receipt must describe the actual database owner. A platform
fallback before destructive setup needs the same isolation boundary as normal
workspace provisioning.
