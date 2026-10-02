---
id: 2026-10-01-blob-fixture-nested-jsonb-oom-killed-shared-postgres
date: 2026-10-01
title: A blackbox blob fixture built with nested jsonb took one Postgres backend to 4.4GB and got it OOM-killed mid-suite
surface: back-end
component: blackbox-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: indexeddb-upload-memory.blackbox.ts and seed-blob-origin-memory.blackbox.ts built a ~50MB blob by wrapping a 360k-row jsonb_agg in nested jsonb_build_* calls
symptoms:
  - "FATAL: the database system is in recovery mode"
  - "Out of memory: Killed process (postgres)"
  - "Failed to create anonymous session"
  - deploy stage backend-coverage-blackbox exit=1
tags:
  - deploy
  - blackbox
  - postgres
  - memory
sources:
  - PR #1364
repro: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts
status: fixed
---

## Problem

`/deploy` Step 4a (backend coverage + blackbox) failed on a Cursor Cloud VM with five failed domains: `indexeddb-upload-memory`, `integration-connection-sync`, `integrations-passkeys`, `integrations`, and `invite-codes`. The errors had nothing in common at first sight (Prisma `P1017` connection resets, "Failed to create anonymous session" 500s), and the same lane had passed twice earlier on the same branch.

## Diagnosis

The Postgres server log shows `server process was terminated by signal 9` at 23:12:33, followed by `the database system is in recovery mode` for every client, and `dmesg` shows a global OOM kill of one `postgres` process holding 3.3GB of anonymous memory. The query that process was running was the `idb_upload_memory_fixture` CTE from `indexeddb-upload-memory.blackbox.ts`. Every domain that was connected while Postgres restarted failed; those are the other four.

The fixture wrapped a 360k-row `jsonb_agg` in seven levels of `jsonb_build_object` / `jsonb_build_array`. Each level keeps another full copy of the blob in the backend until the statement ends. Measured inside the backend (`VmHWM` from `/proc/self/status`), the statement peaked at 4406MB to build a 50MB document. Its round-trip check, which parsed the 50MB file again as `$1::jsonb`, cost about 2.2GB more. `seed-blob-origin-memory.blackbox.ts` used the same four-level builder and peaked at 2633MB. The earlier runs survived because the box had more headroom. This time the Step 5 local stack was already running next to all four Group 3 lanes, so the spike crossed the 16GB limit.

`pg_postmaster_start_time()` does not change on crash recovery (it still read the 19:46 boot time), so neither the runner nor the failing domains could tell that the database had restarted under them.

## Solution

`back-end/src/tests/blackbox/blob-origin-fixture.helpers.ts` holds the one blob builder for both suites. It renders the `databases` value as text with a single `string_agg`, already in jsonb's canonical output form. The upload suite concatenates the envelope around that text and gets the expected `md5:length` digest from the same statement, so the 50MB document is never parsed on the server. The seed suite casts the text to `jsonb` once on insert. The output is byte-identical to the old builder (same length and md5, 52,338,166 chars).

`measureBackendPeak` runs a fixture on a fresh single-connection client and reads that backend's peak RSS from inside Postgres. Both suites now assert that peak against `BLOB_FIXTURE_BACKEND_PEAK_MB` (1536MB). The upload suite also asserts that its fixture text equals its own jsonb rendering, which the byte-for-byte round-trip check depends on.

With the old nested builder swapped back into the helper, the new assertions fail: 2985MB in the upload suite and 3471MB in the seed suite, with every other case still passing. With the fix, both domains pass (8/8 and 4/4) at 480MB and 964MB.

## Human feedback

None recorded.

## Reusable lesson

A test fixture shares its database and its box with every other gate, so its server-side memory is part of the contract, not an implementation detail. Build large JSON fixtures as text in one pass and measure the backend that builds them. A Postgres crash-restart shows up as unrelated failures in whatever domains were connected, so when several domains fail with connection resets, check the server log and `dmesg` first.
