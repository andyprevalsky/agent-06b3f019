---
id: 2026-10-03-blackbox-runners-inherited-injected-r2-archive-backend
date: 2026-10-03
title: Backend blackbox runners inherited the Cloud-injected TRACE_ARCHIVE_BACKEND=r2, so agent-trajectories read nothing back and test agents were archived to the production bucket
surface: harness
component: backend-blackbox-runner
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/run-blackbox-tests.sh and back-end/scripts/run-coverage.sh exported TRACE_ARCHIVE_BACKEND="${TRACE_ARCHIVE_BACKEND:-local}", so an injected r2 value reached the backend under test while the blackbox wrote local archive files
symptoms:
  - "--- FAIL: agent-trajectories ---"
  - "Error: Expected 2 trajectory hits, got {\"status\":200,\"data\":{\"matches\":[],\"total_matches\":0"
  - "Trace archive finalized root_agent_id=... manifest_ref=r2://"
tags:
  - blackbox
  - coverage
  - archive
  - cursor-cloud
  - deploy
sources:
  - PR #1401
repro: scripts/tests/blackbox-archive-env.test.sh
status: fixed
---

## Problem

After merging main into the PR #1401 branch, the deploy backend coverage lane failed in the new `agent-trajectories` blackbox domain: the archive-only search expected 2 trajectory hits and got 0. Running `bash scripts/run-blackbox-tests.sh agent-trajectories` alone on the Cursor Cloud VM failed the same way every time.

## Diagnosis

The test writes an archived trace through the local archive backend (`TRACE_ARCHIVE_BACKEND=local`, `TRACE_ARCHIVE_LOCAL_DIR=.context`) and then asks the backend under test to grep it. Both runners meant to force a local archive ("blackbox tests assert local archive artifacts"), but they used `${TRACE_ARCHIVE_BACKEND:-local}`. Cursor Cloud injects `TRACE_ARCHIVE_BACKEND=r2` into the process environment as a secret, so the default never applied. The backend under test looked in the production R2 bucket and found nothing. Developer machines and GitHub CI do not inject the variable, which is why main stayed green.

The same inheritance meant the coverage backend uploaded test agents to the production bucket. `back-end/coverage/server.log` from the failing run shows 117 distinct finalized test roots with `manifest_ref=r2://...`. Every earlier coverage run on this VM did the same.

Local repro: with the injected env still set, `run-blackbox-tests.sh agent-trajectories` fails on the old runner and passes with the fix. The new `scripts/tests/blackbox-archive-env.test.sh` fails on the old runner with `run-blackbox-tests.sh children saw: archive=r2|...` and passes on the fixed one.

## Solution

- `scripts/lib/blackbox-archive-env.sh` provides `pin_blackbox_trace_archive_env`, which always exports `TRACE_ARCHIVE_BACKEND=local` and keeps the existing defaults for the archive dir and enabled flag. Both runners call it in place of the overridable defaults.
- `scripts/tests/blackbox-archive-env.test.sh` runs in the deploy structural gates. It covers the helper, drives the real `run-blackbox-tests.sh --list` with a fake `node` to check what child processes inherit, and checks that `run-coverage.sh` pins before it boots its backend.
- Open follow-up: the test bundles already uploaded from Cloud VMs remain in the production bucket. Removing them is a destructive production-data action that needs operator review (run the archive curation script with `--dry-run` first).
- No 10,000-agent impact: test-harness only.

## Human feedback

None recorded.

## Reusable lesson

A test runner that must isolate itself from production should pin the isolating value, not default it. Injected environments override `${VAR:-default}` silently.
