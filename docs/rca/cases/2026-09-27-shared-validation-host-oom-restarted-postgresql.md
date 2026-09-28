---
id: 2026-09-27-shared-validation-host-oom-restarted-postgresql
date: 2026-09-27
title: Shared validation host exhausted RAM and restarted PostgreSQL
surface: back-end
component: cloud-controller-test-capacity
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: PostgreSQL constructed the unchanged large JSON fixture on an 8 GiB validation host shared with concurrent Node coverage and no swap
symptoms:
  - "database system is not yet accepting connections"
  - "Consistent recovery state has not been yet reached"
  - "Killed process 19627 (postgres)"
  - "idb_upload_memory_fixture AS MATERIALIZED"
tags:
  - cloud-controller
  - postgres
  - oom
  - coverage
sources:
  - PR #1299
  - commit f94858c8316609b2c8e7c94c07f2b74a7672687f
repro: back-end/src/tests/blackbox/indexeddb-upload-memory.blackbox.ts
status: open
---

## Problem


The canonical f94858c8316609b2c8e7c94c07f2b74a7672687f Linux backend coverage gate failed with 16 of 165 blackbox domains and three unit files red. At 23:12:30 UTC the kernel killed PostgreSQL PID 19627 with 4,261,896 KiB anonymous RSS. The postmaster identified that exact PID and the `idb_upload_memory_fixture AS MATERIALIZED` query, terminated sibling connections, and recovered until 23:12:43.824. The fixture was building 360,000 nested JSONB records before its 256 MiB Node control and treatment children started. The host had 8,132,804 KiB RAM, no swap, and 7,246,260 KiB summed process anonymous RSS; backend Node PID 3137 accounted for 1,980,712 KiB. Kernel and PostgreSQL logs directly bind the victim and recovery errors. Neither disk was full.

The fixture SHA256 886c10a286d7b5d5703a912822c1852e9f9bb6b3460130692d64e6cd7e5421bd is identical on 14f, 9f and f948. Earlier 14f canonical coverage passed 165 domains on Darwin with Docker PostgreSQL. That pass did not prove equivalent concurrent memory capacity on the 8 GiB Linux host. The older host's physical RAM was not measured in this investigation.

## Diagnosis

### Archive searches

Searches used `database system is not yet accepting connections Consistent recovery state` and `PostgreSQL server crash restart recovery memory disk full`. No exact earlier PostgreSQL recovery case was found. `2026-08-12-indexeddb-upload-json-codec-ooms-backend` is a relative: it introduced this regression fixture for a Node codec bug. The current boundary is shared validation-host capacity while PostgreSQL constructs the fixture, not the production upload implementation. The unpaged seed OOM case is also a relative; the present fixture has a fixed record count and unchanged payload and heap assertions.

## Solution

### Setup remediation and native verification

An independently reviewed setup-only change activated one private 4 GiB swap file on the existing owned persistent volume. Its ledger binds app, machine, instance, volume, owner, source head and file inode/device. Native allocation, format and activation exits and exact child retirement are retained. No test size, heap limit, concurrency, timeout, model, benchmark, evaluator, PostgreSQL setting or repository file changed. The file remains owned for the controller lifetime, without broad swapoff or automatic growth.

The unchanged `indexeddb-upload-memory` domain passed all six assertions in 27.833 seconds (driver native exit 0 in 41.45 seconds). The failed-domain replay passed all 15 domains at unchanged domain concurrency 4 and case concurrency 30 in 38.72 seconds. The three failed unit files then passed all 28 assertions at unit-file concurrency 3 in 1.54 seconds. Full kernel and PostgreSQL captures show no new OOM or recovery. The 15-domain PostgreSQL RSS peak was 4,880,187,392 bytes; minimum available memory was 1,607,348,224 bytes.

Every targeted run used zero swap. These narrower successes therefore cannot prove that swap prevented the original full-load failure. Full canonical backend coverage with original concurrency remains mandatory. The original failures are preserved and have not been relabeled.

### Separate environment and lifecycle findings

The Codex refresh-token failure preceded PostgreSQL recovery and was independently repaired with a local-only authorized auth overlay; its unchanged domain passed 24 assertions. The Rose dump assertion failed because of the controller's inherited `FLY_APP_NAME` selecting production behavior in local backend tests. The approved replay removes that variable only from the backend test child and keeps controller ownership authority intact. Neither finding is attributed to PostgreSQL.

The standalone backend runner's native exit 0 left three owning-replay descendants and two failed-set descendants live. Exact native identities, run environment and original process groups bound each retirement. Identity-checked pidfd TERM retired only those processes; final scans found no members of the four exact test groups or either recorded blackbox run, and ports 3101, 3102 and 3103 had no listeners. This lifecycle defect has a separate owner and was not hidden by successful assertions. The earlier statement that wrapper exit proved all descendants gone was corrected by these explicit receipts.

### Evidence and remaining work

`final-capacity-summary.json` pins 130 evidence files and records targeted outcomes and their limits. Key inputs include `preliminary-findings.json`, `swap-independent-review.json`, `swap-native/readback.json`, all three replay directories and `final-quiescence.json`. The original gate is `proof21-r3-final-integration/gates.json` and `backend.log`. Parent owns the archive/index and full-gate decision. The first private replay launcher failed before any subprocess because the artifact parent was missing; that failure remains preserved separately.

## Human feedback

The standing user requirement is infrastructure-only work without weakening benchmark behavior or criteria. No additional incident-specific human feedback is claimed.

## Reusable lesson

Validate shared database memory capacity with the unchanged full concurrent gate before treating isolated fixture passes as proof of capacity.
