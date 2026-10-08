---
id: 2026-10-07-coverage-prisma-pool-4-starved-google-grep
date: 2026-10-07
title: Backend coverage Prisma pool of 4 starved data-google-sources grep under concurrent long domains
surface: harness
component: run-coverage
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/scripts/run-coverage.sh defaulted BACKEND_TEST_DB_CONNECTION_LIMIT to 4 while blackbox concurrency 3 shared one backend pool
symptoms:
  - "Timed out fetching a new connection from the connection pool"
  - "connection_limit: 4"
  - "FAIL data-google-sources GREP_FAILED"
  - "backend-coverage-blackbox exit=1"
tags:
  - deploy-gate
  - prisma-pool
  - coverage
  - data-google-sources
sources:
  - PR #1436
  - task backend coverage 20261007-202927-10987
repro: back-end/scripts/run-coverage.sh
status: fixed
---

## Problem

Deploy run `20261007-202927-10987` failed backend coverage twice after the
Cerebras quota skip landed. The remaining failure was `data-google-sources`
(`GREP_FAILED`, Prisma `findUnique` pool timeout, `connection_limit=4`,
30s). Isolated `BLACKBOX_TEST_CONCURRENCY=1` passed in 5248ms. The same
suite's overlapping `data-real-user` (108s) and `download-telemetry` (74s)
held the shared backend pool.

## Diagnosis

Coverage pins one local Prisma pool on the isolated backend. Default 4 slots
cannot serve three concurrent domains when two of them keep connections for
tens of seconds. The grep path then waits 30s, retries, and reports
`GREP_FAILED`. Host Postgres `max_connections` is 300, so the bound was not
protecting a real ceiling — it was starving the suite.

## Solution

Default `BACKEND_TEST_DB_CONNECTION_LIMIT` to 16. Keep the override and the
positive-integer check. Update the coverage-script contract that pins the
default. Isolated google-sources remains the concurrency=1 proof that the
domain itself is green.

## Human feedback

Do not treat a pool timeout under coverage load as a product grep bug when
the same domain passes isolated.

## Reusable lesson

A shared test-backend pool must be sized for the prescribed domain
concurrency plus the longest overlapping holders, not for a single request.
