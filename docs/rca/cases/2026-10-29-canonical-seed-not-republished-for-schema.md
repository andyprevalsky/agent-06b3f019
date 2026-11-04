---
id: 2026-10-29-canonical-seed-not-republished-for-schema
date: 2026-10-29
title: Benchmark startup required an unpublished current-schema canonical seed
surface: harness
component: canonical-seed-publication
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The current schema generated a new canonical seed key that had never been published
symptoms:
  - canonical base fixture is unavailable for this schema/revision
  - Benchmarks require the canonical base fixture
  - seed-dump-cache head exits 3
tags:
  - benchmark-seed
  - schema-migration
  - artifact-publication
sources:
  - PR #1634
repro: scripts/run-predeploy-local
status: fixed
---

## Problem

Local smoke failed before task admission because the schema-keyed canonical
PG16 seed was absent. The runner correctly refused a production cold-sync
substitute. Original run1793300744-705123-77342 and its clean stack teardown
receipt are retained; it did not execute benchmark tasks.

## Diagnosis

The current schema hashes to585890d5520726e2f14d791fb1231273a93c7f4b. Its
PG16 key returned head exit3, while the earlier reviewed fixture75b0972f
from schema commit3f1754c4c remained available. Six schema migrations had not
been propagated to the canonical artifact. Existing daily dumps were not
accepted as canonical substitutes. The migration script and prior publication
cases were inspected before choosing the repair.

## Solution

Run the supported scripts/migrate-canonical-seed.sh using PG16 and the exact
base schema, applying trajectory skip-lock, paused browser state, user-pause
replay index, project CLI login, project maintenance, and agent-speed migrations.
The script restored the previous canonical fixture into an owned scratch DB,
validated its content, dumped and restored a second DB, compared every table's
row count, published the new immutable key, then downloaded and compared bytes.

The operation passed in32seconds. Both validations preserved3825 WhatsApp
messages, a connected integration,241 archived trajectories across3runs and
the named benchmark profile. Published size31146496bytes; new head exits0 and
old head still exits0. Exact command, log hashes and cleanup evidence are in
.context/pr1634-canonical-pg16/receipt.json and run.log. Only the owned scratch
container and its verified unreferenced anonymous volume were removed. No
production DB writes or source changes were needed. The original smoke command
is rerun separately; artifact recovery alone is not a task-verdict pass.

## Human feedback

The user requested completing deployment and fixing intervening issues. No
canonical-fixture guard or smoke gate was waived.

## Reusable lesson

After schema changes, migrate and validate the reviewed canonical seed under
its new immutable key; never relabel an older dump or silently cold-sync prod.
