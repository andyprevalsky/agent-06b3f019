---
id: 2026-10-03-blackbox-runners-inherited-injected-r2-archive-backend
date: 2026-10-03
title: Backend blackbox runners passed an injected TRACE_ARCHIVE_BACKEND=r2 to the isolated test backend, so agent-trajectories read R2 for archives the test wrote locally
surface: harness
component: backend-blackbox-runner
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/run-coverage.sh and run-blackbox-tests.sh exported TRACE_ARCHIVE_BACKEND="${TRACE_ARCHIVE_BACKEND:-local}", which overrides back-end/.env but keeps a value the Cloud VM injects into the process environment
symptoms:
  - "Expected 2 trajectory hits, got {\"status\":200,\"data\":{\"matches\":[]"
  - "No matches for 'Archive-only' in agent_trajectories."
  - "FAIL  agent-trajectories"
tags:
  - blackbox
  - archive-backend
  - cloud-vm
  - deploy-gate
sources:
  - PR #1341
repro: on a shell with TRACE_ARCHIVE_BACKEND=r2 exported, `bash scripts/run-blackbox-tests.sh agent-trajectories` fails 0/1 before the fix and passes 1/1 after; with the variable unset it passes either way. `coverage-script.part2.test.ts` fails before the fix.
status: fixed
---

## Problem

After this branch merged `main` (which added trajectory grep), `/deploy` run
`20261002-213707-2123940` failed backend coverage on one domain:
`agent-trajectories`, 171/172 passed. Its R2-only history case expected 2 hits
for `Archive-only` and got none.

## Diagnosis

### Evidence

- The case sets `TRACE_ARCHIVE_BACKEND=local` in its own process, writes a
  manifest, fixture, and LLM trace to the local archive directory, then greps
  through the backend API.
- The Cloud VM injects `TRACE_ARCHIVE_BACKEND=r2` into every shell (Cursor
  Secrets), and `back-end/.env` also sets it.
- Both runners export `TRACE_ARCHIVE_BACKEND="${TRACE_ARCHIVE_BACKEND:-local}"`.
  `run-coverage.sh` states the intent: "blackbox tests assert local archive
  artifacts". The default only beats `.env`, because dotenv never overrides a
  set variable. An injected value passes straight through to the isolated
  backend.
- Repro with the deploy lane environment: inherited `r2` fails 0/1; the same
  command with the variable unset passes 1/1.

### Root cause

The runners treated "not set by `.env`" as "not set". On a host that injects
the prod archive backend, the isolated test backend read from R2, and archive
writes that go through the server could reach the real archive bucket.

## Solution

Both runners now export
`TRACE_ARCHIVE_BACKEND="${BLACKBOX_TRACE_ARCHIVE_BACKEND:-local}"`, the same
blackbox-scoped override pattern the runner already uses for the Fast Mode
proxy URLs. `coverage-script.part2.test.ts` requires that form in both
harnesses. With `r2` still injected, `agent-trajectories` passes 1/1.

Benchmark stacks are intentionally different: `run.sh --benchmark` keeps an
injected R2 backend so gold traces outlive their fleet volume
(`test_benchmark_stack_does_not_override_injected_r2_archive_backend`).

## Human feedback

None recorded.

## Reusable lesson

`${VAR:-default}` in a test runner protects against `.env`, not against the
host. When a suite's assertions depend on a value, the runner must set it from
a test-scoped variable rather than inherit the general one.
