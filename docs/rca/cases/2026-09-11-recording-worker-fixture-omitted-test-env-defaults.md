---
id: 2026-09-11-recording-worker-fixture-omitted-test-env-defaults
date: 2026-09-11
title: Recorder worker regression depended on a developer dotenv file during child import
surface: harness
component: recording-archive-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the recorder worker fixture imported application helpers before applying shared test environment defaults in its allowlisted subprocess environment
symptoms:
  - recorder never reached the loopback archive
  - "KeyError: 'TEMPORAL_API_KEY'"
  - recording-archive passed four cases and failed its worker-exit case in Linux coverage
tags:
  - recording
  - blackbox
  - subprocess
  - dotenv
  - test-environment
sources:
  - PR #1299
  - commit 94298e731733a0a1db24fa7a431328779b65c92b
repro: agents/tests/blackbox/recording_archive.blackbox.py
status: fixed
---

## Problem

The recorder archive domain failed its worker-exit regression in the prepared
Linux coverage runtime. Its other four cases passed. After the unchanged
15-second first-request wait, the worker had never contacted the fixture's
loopback archive server. The original failure discarded supervisor stderr and
removed the worker log with its temporary directory.

## Diagnosis

Running the same checked-in test while retaining its temporary directory exposed
`KeyError: 'TEMPORAL_API_KEY'` in the actual worker subprocess. Its recorder import
loaded `helpers/__init__.py`, then `helpers/check_usage.py`, whose module-level
`load_config()` required the absent key. No recording publication had started.

The child deliberately received only an allowlisted fixture environment, but
unlike the adjacent archive-lease child it never applied
`tests.env_defaults.apply_test_env_defaults()`. A developer's `agents/.env`
could satisfy the lazy configuration import on macOS. The Linux source snapshot
contained no secret dotenv file, exposing the incomplete fixture bootstrap.
The cause is missing deterministic child configuration, not slow archive HTTP.

The exact failure is retained in
`.context/acceptance/linux-api-runtime/exec-d64d0a10e4054d24888b6a53fd63239c.log`.
The same lifecycle reproduction passed after the fixture repair in
`exec-38e36e59f39d495385ba5584866972be.log`. The canonical command
`cd agents && venv/bin/python scripts/run_blackbox_tests.py recording-archive`
then passed all five cases in 2.5 seconds, recorded in
`exec-280f7d995d9446b68d85cabde5a5ec63.log` under that directory.

Archive searches used `TEMPORAL_API_KEY test environment defaults` and
`standalone child fixture missing dotenv`. The archived reproduction hydration
case is a related environment class, but concerns access to dependencies rather
than missing child configuration. No completed plan mentioned the affected test
or supervisor files.

## Solution

Apply the existing shared test defaults before the recorder import and set
`PYTHON_DOTENV_DISABLED=1` in this child's explicit environment. The supplied
loopback endpoint, encryption key and fake backend key keep precedence. This
makes the child independent of developer credentials on both platforms.

On startup failure, collect at most 8 KiB each from worker and supervisor logs,
include that bounded context in the assertion, and retain private log files in
the canonical test artifact directory. The first-request, shutdown and response
bounds, actual supervisor, encryption, HTTP, ownership and all-file assertions
are unchanged. Independent review passed; the deploy-discovered five-case domain
passed in Linux. This test-only change adds no production per-agent work.

This closes the fixture defect only. The separate recording publication case
remains open for its unchanged live benchmark and cloud fleet outcome gates.

## Human feedback

The user required completion without repeated permission questions and retained
the ten sequential cloud fleet slices as the acceptance criterion. No test
bootstrap repair changes that acceptance criterion.

## Reusable lesson

Apply deterministic test defaults inside each isolated child before importing
application configuration, and retain bounded startup diagnostics when the child
never reaches the tested boundary.
