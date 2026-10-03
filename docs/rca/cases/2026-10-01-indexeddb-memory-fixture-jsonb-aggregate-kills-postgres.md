---
id: 2026-10-01-indexeddb-memory-fixture-jsonb-aggregate-kills-postgres
date: 2026-10-01
title: IndexedDB memory-test fixture killed the shared PostgreSQL process
surface: harness
component: indexeddb-upload-memory-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts buildPayloadFile assembled 360000 records with one PostgreSQL jsonb_agg
symptoms:
  - 'server process (PID 6984) was terminated by signal 9: Killed'
  - 'WITH idb_upload_memory_fixture AS MATERIALIZED'
  - 'FATAL: the database system is in recovery mode'
  - '--- FAIL: indexeddb-upload-memory ---'
tags:
  - indexeddb
  - blackbox
  - postgres
  - jsonb
  - memory
  - test-fixture
sources:
  - PR #1344
repro: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts
status: fixed
---

## Problem

The backend `/deploy` coverage gate failed on unrelated integration and unit
tests while the IndexedDB upload memory blackbox built its large fixture. The
second run's PostgreSQL container log at 2026-10-01 23:46:39 UTC recorded
`server process (PID 6984) was terminated by signal 9: Killed` and named the
running `WITH idb_upload_memory_fixture AS MATERIALIZED` query, including its
`generate_series(1, 360000)` aggregate. PostgreSQL terminated other sessions
and recovered. Concurrent blackboxes then received
`FATAL: the database system is in recovery mode`, including the cookies upload
and integrations routes. The captured backend gate is
`.context/deploy-runs/20261001-233216-79000/logs/backend-coverage-blackbox-20261001-234443-86594.log`;
the decisive container excerpt is
`.context/indexeddb-fixture-postgres-kill-20261001.log`.

The unchanged reproduction command from `back-end/` was
`BLACKBOX_TEST_CONCURRENCY=4 CONTRACT_TEST_CONCURRENCY=4 BACKEND_UNIT_CONCURRENCY=3 npm run test:coverage`.
Before the fix it exited 1, with `--- FAIL: indexeddb-upload-memory ---`
and `FATAL: the database system is in recovery mode` in the gate artifact.

## Diagnosis

Critical path: backend coverage starts 167 blackbox domains against one local
PostgreSQL container → `indexeddb-upload-memory` asks PostgreSQL to materialize
a 360,000-record nested JSONB value → the server process is killed while
executing that query → PostgreSQL aborts all sessions and recovers → unrelated
domains fail. The first bad boundary is test fixture construction. The test is
meant to constrain *Node upload ingest* to a 256 MB heap; building its input in
the shared database instead ran a large single JSONB aggregate in PostgreSQL.
The DB log ties the killed process to that exact fixture query, and the
recovery errors prove the effect on the other domains. Memory pressure is a
plausible reason for the SIGKILL, but the captured logs do not identify its
sender or establish an OOM event.

Archive searches: `idb_upload_memory_fixture signal 9 PostgreSQL JSONB
aggregate` and `indexeddb memory blackbox shared database fixture coverage`.
The September 30 IndexedDB fixture-identity case is a **relative** concerning
the same test, but its first bad boundary was shared temp paths and user IDs.
This case concerns fixture construction running in the shared database at the
time the PostgreSQL process was killed.

## Solution

`buildPayloadFile` now writes the same 360,000 nested records to its owned
payload file in bounded batches. It retains the two origins, md5 record values,
the minimum-size assertion, the 256 MB control OOM assertion, treatment ingest,
and the database md5 round-trip check. The existing blackbox is in the full
backend coverage gate; its fixture creation no longer asks PostgreSQL to
materialize the 47.5 MB JSON document. The focused domain passed 8/8 after the
change in 14.8 seconds at
`.context/test-runs/1790898692-9167-22960/indexeddb-upload-memory.log`.
The unchanged full backend coverage command then exited 0: all 227 unit files
and all 167 blackbox domains passed, including `indexeddb-upload-memory`, and
coverage reached 89.38% statements, 80.15% branches, 91.78% functions. The
post-fix gate is
`.context/deploy-runs/20261001-233216-79000/logs/backend-coverage-blackbox-20261001-235705-56514.log`.

This changes only local test construction. At 10,000 agents it adds no
production work; during deploy it keeps a large test input off the shared
database and confines construction to a bounded Node string batch.

## Human feedback

The user instructed us to finish the deploy rather than stop after a partial
result or a new approval request.

## Reusable lesson

Build stress-test inputs outside shared services, with bounded fixture memory,
so the fixture cannot take down the service the suite is testing.
