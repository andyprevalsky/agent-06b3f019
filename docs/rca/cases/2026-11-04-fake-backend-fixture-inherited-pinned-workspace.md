---
id: 2026-11-04-fake-backend-fixture-inherited-pinned-workspace
date: 2026-11-04
title: Fake backend adapter fixtures inherited the structural worker pinned Postgres mode
surface: harness
component: deploy-test-worker-backend-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Backend.setUp preserved the caller ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 while constructing a fake runner root without a pinned Postgres fixture
symptoms:
  - "ValueError: prepared Postgres fixture is missing or unreadable"
  - "deploy-test-worker: 125 tests, 16 errors"
  - "test_failed_shard_raw_archive_is_read_from_its_announced_child_log"
tags:
  - structural
  - backend
  - fixture
  - environment-isolation
  - postgres
sources:
  - commit 392dc5d8ab64daf4019651c3dc99435bc9abd1bf
  - commit 8c63501f0afa0e3f4c5aafd3e29e01a119eb5f2a
  - agent ph72zvt6ajw53yyee7hzkc81818hecwb evidence /var/tmp/pr1662-54-backend-fixture-env/report.json
  - agent ph72zvt6ajw53yyee7hzkc81818hecwb evidence /var/tmp/pr1662-54-backend-fixture-env/causal-red.log
  - agent ph72zvt6ajw53yyee7hzkc81818hecwb evidence /var/tmp/pr1662-54-backend-fixture-env/causal-green.log
  - agent ph72zvt6ajw53yyee7hzkc81818hecwb evidence /var/tmp/pr1662-54-backend-fixture-env/owning-backend.log
repro: scripts/tests/deploy-test-worker.test.py Backend.test_failed_shard_raw_archive_is_read_from_its_announced_child_log
status: open
---

## Problem

Round 54 at `392dc5d8` retained a native structural failure: the
`deploy-test-worker` suite ran 125 tests and recorded 16 error entries.
The first was the existing Backend raw-shard-archive test. Its fake runner
never reached the intended archive assertions because prepared Postgres
admission raised the exact error above. The original native log has SHA256
`d2993a78e88a0b047b8ec74564f9d19b22ff80f2f6e414d5f9392eecc1e7d36d`.

## Diagnosis

The actual structural recipe supplies workspace
`pr1662_structural_c_native577`, port `22550`, trust `1`, and
`ROSE_USE_SYSTEM_PG=true`. Backend.setUp overlaid fake npm/npx but retained
that trusted workspace mode. The production adapter consequently entered
`restore_workspace_postgres` before the fake sweep, although this general
fixture root owns neither a pinned container nor its helper. System-PG=true
alone does not satisfy the adapter's explicit prepared-system-PG exception.

The private original test reproduced the same error under those four inherited
values. The unchanged test command and inherited values passed after the
fixture-only correction below. No real Docker, database or provider command
ran. The registered Backend class then passed all 23 tests once in 9.926s,
including explicit pinned-fixture restore and refusal controls.

Git history first adds the production restore path in `8c63501f`; the missing
fixture isolation is a branch-owned integration defect. No execution of its
parent revision is claimed. The bounded archive searches found no exact
owning recurrence. The October 27 Docker database-selection case is a relative
with a different first-bad boundary and is not adopted as this cause.

## Solution

Private patch SHA256
`b339a17ff73ccd172bd396df4e1df0cca84814f7e1f25acae53f8908b89e5076`
adds an explicit temporary `ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=0` declaration
and a comment to Backend.setUp. The dedicated Postgres fixtures still
explicitly set trust=1 with their existing fake Docker identities. All 125
existing test-method ASTs, assertions and timeouts are unchanged; production
backend, worker and cycle modules are byte-identical.

The causal RED/GREEN and 23-test class PASS establish this fixture repair.
Status remains OPEN pending integration and the required native structural
validation. The original round-54 failure remains retained; these controls
are not a full-gate PASS. This occurrence does not explain or close round
52's separate preparation-exception gap. No production admission bypass,
source/environment configuration write, floor or concurrency change is part
of the repair.

## Human feedback

None recorded for this occurrence.

## Reusable lesson

Declare a fake fixture's ownership mode explicitly instead of inheriting a caller's pinned workspace mode.
