---
id: 2026-07-04-shared-env-r2-archive-backend-diverged-from-test-local-read
date: 2026-07-04
title: The backend archived to R2 while the test process was forced to `local`, so the archive blackbox read an empty directory
surface: back-end
component: trace-archive
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/.env (a shared symlink) set TRACE_ARCHIVE_BACKEND=r2 while run-blackbox-tests.sh:19 forces the TEST process to ${TRACE_ARCHIVE_BACKEND:-local}
symptoms:
  - "archive blackbox fails: expected encrypted manifest artifact to be readable"
  - readArchivedArtifact returns null immediately
  - no "Trace archive read failed" warning is logged at all
tags:
  - trace-archive
  - r2
  - blackbox
  - shared-env
  - deploy-gate
sources:
  - memory:project_deploy_gotchas_local_stack
repro: back-end/src/tests/blackbox/archive.blackbox.ts
status: fixed
---

## Problem

The `archive` blackbox domain failed with "expected encrypted manifest artifact to be
readable". The tell was the _shape_ of the failure: `readArchivedArtifact` returned
null fast, with **no** "Trace archive read failed" warning — so nothing had errored;
the read had simply found nothing.

## Diagnosis

Two processes disagreed about where archive artifacts live.

`back-end/.env` — which is a **symlink to the shared** `conductor/repos/.../back-end/.env`
used by every worktree, and must not be edited — set `TRACE_ARCHIVE_BACKEND=r2`, so the
backend-under-test wrote artifacts to Cloudflare R2. Meanwhile
`run-blackbox-tests.sh:19` forces the **test** process to
`${TRACE_ARCHIVE_BACKEND:-local}`, so the test read the local filesystem. The test
therefore looked in an empty local directory, never reaching `readR2Object` — which is
exactly why no read-failure warning appeared.

The archive code path was identical to main; this was purely a writer/reader
configuration split, and the deploy skill's Step 5a assumes `local`.

## Solution

Launch `run.sh` with a `TRACE_ARCHIVE_BACKEND=local` **process-env override** (dotenv
will not clobber an already-set variable) so the backend archives locally and matches
the test's `local` read. This requires no edit to the shared `.env` and does not
pollute prod R2.

## Human feedback

None recorded.

## Reusable lesson

When a read returns null with no error logged, check that writer and reader were
pointed at the same storage backend — and override a shared symlinked `.env` via
process env rather than editing it.
