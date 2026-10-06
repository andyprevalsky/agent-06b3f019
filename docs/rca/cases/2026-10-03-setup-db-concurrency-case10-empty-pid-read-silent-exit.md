---
id: 2026-10-03-setup-db-concurrency-case10-empty-pid-read-silent-exit
date: 2026-10-03
title: setup-db-concurrency exited 1 with no output when case 10 read its helper's PID file before the PID was written
surface: harness
component: deploy-structural-gates
classification: test-bug
problem_class: other
first_bad_boundary: scripts/tests/setup-db-concurrency.test.sh case 10 — the helper wrote its PID with Path.write_text (file created empty, then filled), and the shell read it at once; `ps -p ""` then failed inside an errexit + pipefail command substitution, exiting before any diagnostic
symptoms:
  - "== setup-db-concurrency: exit=1 duration=26.88s =="
  - "failed deploy structural gates: setup-db-concurrency"
  - empty gate output (no FAIL line)
tags:
  - deploy
  - structural-gates
  - flaky-test
  - bash-errexit
sources:
  - PR #1401
repro: PYTHONPATH=<dir with a sitecustomize.py that pauses pathlib.Path.write_text between open and write> bash scripts/tests/setup-db-concurrency.test.sh
status: fixed
---

## Problem

During the PR #1401 deploy, the Step 4s structural gates failed on `setup-db-concurrency` with exit 1 and an empty log. The same gate passed in earlier runs of this deploy, solo, and in 22 parallel stress copies.

## Diagnosis

Every `fail` path in the test prints a message, so an empty exit 1 means bash `errexit` stopped it. The only commands that can fail silently are the two `ps … 2>/dev/null | awk …` command substitutions in case 10. Their stderr is discarded, and under `pipefail` a failing `ps` makes the assignment fail.

The failed gate run left its case-10 helper processes alive: `python3 …/detaching-child.py` PIDs 1231594 (parent) and 1231622 (child), started at about 04:12 by that gate. The child was still waiting for its trigger file. So the test died after it saw the PID file and before it wrote the trigger. The only silent-fail command in that span is the first `ps` probe, and it fails only when the PID it reads is empty or invalid.

The helper wrote its PID with `Path.write_text`, which creates the file empty and then writes it. The shell polls for the file to exist and reads it at once. Under deploy load, the shell can read the file in that gap and get an empty PID.

Local repro: a `sitecustomize.py` on `PYTHONPATH` makes `Path.write_text` pause for one second between opening and writing, which recreates the descheduled-writer state. The unchanged test then exits 1 with no output, exactly matching the gate. With the fix, the same command passes. A second shim that makes the helper publish a dead PID exits 1 silently on the old test. On the fixed test it prints `FAIL: case 10: could not capture the seed child's original identity`.

The silent exit also skipped `case10_cleanup`, which leaked the two helper processes found above.

## Solution

- The helper writes its PID to a temporary file and renames it into place, so the file never appears empty.
- Both `ps` probes end with `|| true`, so a failed probe reaches the existing `case10_fail` diagnostics and cleanup instead of exiting silently.
- No product code changed. No 10,000-agent impact: test-only.

## Human feedback

None recorded.

## Reusable lesson

When a shell test polls for a file another process writes, the writer must publish atomically by writing a temporary file and renaming it. Under `set -euo pipefail`, a probe that discards stderr inside `$(…)` must be guarded, or its failure skips the diagnostic written for it.
