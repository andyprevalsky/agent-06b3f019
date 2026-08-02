---
id: 2026-06-30-blackbox-reused-benchmark-backend-pointed-at-prod-supabase
date: 2026-06-30
title: Reusing the benchmark stack's backend for blackbox tests hit the remote prod Supabase, producing false "Agent not found" 404s
surface: back-end
component: blackbox-runner
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: BLACKBOX_TEST_USE_EXISTING_BACKEND=1 — reuses a backend whose DATABASE_URL is the remote prod Supabase, not the local test DB
symptoms:
  - '"Agent not found" 404 in blackbox tests that just created the agent'
  - blackbox passes on its own backend but fails against the run.sh --benchmark backend
tags:
  - blackbox
  - test-isolation
  - supabase
  - deploy
  - false-failure
sources:
  - memory:project_opus48_fastmode_credits_deploy
repro: none-recorded
status: fixed
---

## Problem

Running the blackbox suite with `BLACKBOX_TEST_USE_EXISTING_BACKEND=1` against the
backend started by `run.sh --benchmark` produced false `Agent not found` 404s for
agents the tests had just created.

## Diagnosis

That backend is not pointed at the local test database — it talks to the **remote
prod Supabase**. (`run.sh` derives its workspace from the directory basename, here
`dublin`, with local DB `victoria-db-dublin`, but the benchmark backend's
datasource was the remote one.) So writes and reads landed in different places and
the 404 was truthful about the database it queried. The failure looks like a
product bug in agent lookup while actually being a datasource mismatch introduced
by reusing a backend that was configured for a different purpose.

## Solution

Run the blackbox suite the canonical isolated way — its own backend against the
local DB — rather than reusing the benchmark stack's backend. The general rule: a
test-harness "reuse the running server" switch is only safe if that server's
datasource is the one the tests assume; otherwise the switch silently changes the
system under test.

## Human feedback

None recorded.

## Reusable lesson

Never point blackbox tests at a backend you did not start for them — verify its
datasource first, because a cross-database mismatch surfaces as a plausible 404
rather than as a configuration error.
