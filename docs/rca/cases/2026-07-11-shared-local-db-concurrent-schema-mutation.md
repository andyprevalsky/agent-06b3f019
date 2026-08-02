---
id: 2026-07-11-shared-local-db-concurrent-schema-mutation
date: 2026-07-11
title: Backend coverage run against the shared local Postgres failed five domains from concurrent schema mutation
surface: back-end
component: blackbox-test-harness
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the coverage run pointed at the shared local database instead of the required per-workspace PostgreSQL container, so another workspace's schema mutation landed mid-run
symptoms:
  - five browser/auth blackbox domains fail during a backend coverage run
  - same suite passes when re-run against the per-workspace PostgreSQL container
  - backend coverage reported below threshold only on the shared-database run
tags:
  - blackbox
  - postgres
  - test-isolation
  - coverage
  - docker
sources:
  - PR #754
repro: none-recorded
status: fixed
---

## Problem

A backend coverage run failed five browser/auth blackbox domains. Re-running the
identical suite against the required per-workspace PostgreSQL container passed at
88.07% statements/lines — so the failure was a property of the database the run was
pointed at, not of the code under test.

## Diagnosis

The run used the shared local database, which other workspaces also mutate. A
concurrent schema mutation from another workspace changed the schema underneath the
in-flight suite, and the domains that touch browser/auth tables failed. The deeper
cause is environment selection, not the tests: nothing forced the run onto the
per-workspace container, so a developer or agent could point a full coverage gate
at a shared mutable database and receive failures indistinguishable from real
regressions. That is precisely the shape that gets mislabeled "flaky" or
"pre-existing" and then rationalized away.

## Solution

Re-run and gate against the per-workspace PostgreSQL container, which is the
required environment for blackbox/coverage runs — one database per workspace so no
other workspace's `db push` can mutate the schema mid-suite. This removes the whole
class of cross-workspace interference for every domain, not just the five that
happened to fail.

## Human feedback

None recorded.

## Reusable lesson

Before treating blackbox failures as regressions, confirm the suite ran against
the per-workspace database container — a shared database lets another workspace's
schema mutation fail your suite in ways that look exactly like real bugs.
