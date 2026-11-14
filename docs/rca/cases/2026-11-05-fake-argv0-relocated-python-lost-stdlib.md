---
id: 2026-11-05-fake-argv0-relocated-python-lost-stdlib
date: 2026-11-05
title: Foreign-listener fake argv hid the relocated Python standard library
surface: harness
component: foreign-listener-cleanup-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: disposable cloudflared-shaped Python child inferred its stdlib prefix from a fake argv0
symptoms:
  - foreign ready.json FileNotFoundError in all twelve setUp calls
  - Could not find platform independent libraries prefix
  - No module named encodings
tags:
  - python
  - fixture
  - uv
  - process-custody
sources:
  - commit a58f847aea0e881ffd124fb8f823e0f6d69f10e5
  - commit f8eb1e4dfae5882af4d5ba28015d8d78f257e79c
repro: scripts/tests/foreign-listener-cleanup.test.py ForeignListener.test_positive_native_socket_and_owner
status: open
---

## Problem

The full structural run on f8eb1e4df reported twelve foreign-listener-cleanup setUp errors because the disposable child's ready.json was absent. Temporary-directory cleanup lost its stderr. The original native result remains in canonical .context/cli-nov05-review/structural-repaired-result.json. The original fixture bytes are identical between the isolated a58f847 clone and canonical f8eb1e4df.

## Diagnosis

Gate: INTRODUCED by a58f847, the fixture's original addition. The test launches Python with executable=sys.executable and argv cloudflared,tunnel,--no-autoupdate,--url,http://127.0.0.1:3802. This preserves the exact native process shape required by the custody validator, but a relocated uv interpreter also uses argv0 to locate its standard library. Under the actual worker agents/venv/bin/python resolving to uv CPython3.11.9, the child searched /install/lib/python3.11 and exited1 with init_fs_encoding failure and No module named encodings. It never reached the loopback socket script. This is not evidence of a production listener ownership failure.

The unchanged single test was executed under the exact worker interpreter with a diagnostic-only driver retaining interpreter path/prefix, argv, exit and helper stderr before the temporary directory disappeared. It failed at the same missing ready.json boundary. The exact same driver passed after repair. Full diagnostic JSON, original source and before/after logs are preserved in isolated .context/foreign-listener-resume. Searches used Python/argv0/encodings/uv and fixture/executable/venv/fake-process-argv. Existing interpreter selection cases are relatives; neither establishes this native loader failure. No claim is made about any protected real tunnel process.

## Solution

Bind PYTHONHOME=sys.base_prefix only in the disposable child's environment. This supplies the actual parent interpreter's base standard library while preserving the executable, native argv, socket script, /proc observation, owner evidence and every assertion. Parent environment and production runtime are unchanged. A symlink wrapper or relaxed custody validator is unnecessary.

The unchanged single-case replay passes. All twelve original controls pass under the exact worker uv interpreter (0.500s) and system /usr/bin/python3 (0.549s), including PID/birth/socket/root/owner/hash/proof/token/primary-port and occupied-port allocation negatives. AST comparison confirms all twelve unittest assertions, two timeout expressions and the original five-second readiness deadline are unchanged. This existing suite is already registered in the structural gate. Golden reference: not applicable (no approval-gated hunk). Status remains open pending parent safe-boundary integration and required full gates; no broad structural rerun was launched here.

## Human feedback

The user required reproduction under the actual worker interpreter with preserved child stderr before proposing a cause, existing isolated clone only, minimal fixture executable-boundary repair, all twelve assertions and timeouts retained, and no canonical/worker/provider/money/DB/Kernel/Freedom changes.

## Reusable lesson

When a fixture deliberately replaces Python argv0, explicitly retain the relocated interpreter's base standard-library location and verify it under the owning worker interpreter.
