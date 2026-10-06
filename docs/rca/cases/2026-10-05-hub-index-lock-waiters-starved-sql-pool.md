---
id: 2026-10-05-hub-index-lock-waiters-starved-sql-pool
date: 2026-10-05
title: Concurrent Hub index waiters borrowed SQL connections before shared-lock admission
surface: back-end
component: benchmark-hub-store
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/benchmarkHubStore.ts::withIndexLock opened a transaction before waiting for the global R2 index writer"
symptoms:
  - "HubVisibilityError: benchmark Hub upload failed: The read operation timed out"
  - "canceling statement due to statement timeout"
  - "Timed out fetching a new connection from the connection pool"
tags:
  - benchmark-hub
  - admission
  - postgres
  - advisory-lock
  - concurrency
sources:
  - fleet run 20261006-053218-82418
  - commit f1e756cea51c1946ad80ea8904d88ca0547452ce
repro: back-end/src/tests/unit/benchmark-hub-admission.test.ts
status: open
---

## Problem

The fresh documented 50-copy campaign `campaign-20261006-053209-82156`
failed before allocation. Its r031 controller ran from
`2026-10-06T05:32:13.956147Z` to `05:35:10.867194Z` and exited 1 after four
HTTPS POST response-read timeouts. Its exact run ID was
`20261006-053218-82418`. No execution or allocation receives acceptance credit.

The actual Render application answered this run's four reconciliation GETs
with 404 at `05:33:29.191881Z`, `05:34:01.609537Z`, `05:34:35.819329Z`, and
`05:35:10.183634Z`. Its first stored live bundle was recorded at
`05:35:33.823114276Z`, 22.956 seconds after the controller failed. In the
bounded `05:32–05:40Z` application-log query, 25 POST errors comprised
23 SQLSTATE 57014 statement cancellations and two connection-pool acquisition
timeouts. These are backend admission failures; the client's response-read
timeout alone did not identify that cause.

Private safe receipts are retained under
`.context/fresh-hub-admission-rca-20261006/`: `runtime-failure-shape.safe.json`,
`render-admission-boundaries.safe.json`, and `render-server-errors.safe.json`.
The application-request query hit its 200-entry cap, so it is not a complete
request census. The exact deployed compiled source hash was not recovered.

## Diagnosis

The actual client waited for the HTTPS response status; it did not record an
HTTP rejection or handshake failure. The application received the requests,
but the owning store opened a Prisma transaction for every concurrent index
operation before waiting on `pg_advisory_xact_lock`. All those connections
waited on the same global writer while its holder read and wrote R2 objects.
Queued SQL waiters therefore consumed the finite connection pool and remained
subject to SQL statement deadlines. Increasing a client timeout does not
remove this admission error.

An unchanged-source reduction executes the actual `withIndexLock` and
`putRun` functions against the existing isolated workspace PostgreSQL, with
controlled in-memory object storage. Fifty calls use a six-connection pool and
a transaction-local 80 ms statement deadline as a deterministic fixture input.
On source `f1e756ce`, seven calls completed and 43 rejected with SQLSTATE
57014; six transaction callbacks were simultaneously open. After the repair,
the identical reduction completed all 50 calls with one open callback at a
time. Both runs retained zero advisory locks and performed no schema or row
writes, model calls, or external storage mutations. The safe receipts are
`admission-real-postgres-before.safe.json` and
`admission-real-postgres-after.safe.json`; both bind the same corrected
reproduction hash `bf75f9349dd38c24e46c6d6267c4d19c4da522871b3b0d15365a57de93d86af6`.
The fixture timings are diagnostic and are not benchmark performance evidence.

Archive searches covered `HubVisibilityError TimeoutError _post_run_bundle
HTTPS response`, `benchmark Hub upload registration proxy concurrency`,
`benchmarkHubStore pg_advisory_xact_lock statement timeout connection pool`,
and `Hub concurrent registration before PostgreSQL transaction admission`.
The September 10 ambiguous-commit case was related, but that run had already
committed when its response failed. This run remained absent through every
reconciliation GET. The October 2 plain-JSON rejection case concerned an
upstream 403 without application admission; this application recorded SQL
failures and eventual publication. Neither is this root-cause recurrence.

The global SQL lock cannot be deleted: separate backend processes share an
R2 catalog and otherwise lose updates. The deepest owned correction is to
queue same-process contenders before borrowing a database connection while
retaining that cross-process lock. The reduction isolates admission from
payload size, HTTPS route, and downstream model execution.

## Solution

`withIndexLock` now chains same-process admissions before `$transaction`.
The caller receives its original rejection; a settled failure releases the
tail for the next caller, including failure to acquire the transaction itself.
The SQL key, transaction bounds, critical-section operation, revision/catalog
writes, visibility ordering, and final absorption contracts are unchanged.
No initial-run fast path or speculative object-store parallelism was added.

The checked-in control executes the actual owner extracted from TypeScript.
Its original-source run failed all three initial controls; the repaired owner
passes four controls covering 50-way admission, rejected storage mutations,
transaction-acquisition rejection, and independent backend owners sharing the
database lock. Existing Hub registration, ambiguous-commit reconciliation,
safe rejection, gzip upload, and Hub index/revision controls also pass.
The parent independently reviewed the production byte diff and controls.

At 10,000 contenders, one process holds at most one SQL connection for this
boundary; queued JavaScript promises still consume memory. Separate processes
still coordinate through PostgreSQL, and the global R2 writer remains serial.
This repair does not claim to remove that throughput limit. Production rollout
and a fresh default-Hub 50-copy run remain necessary; this case stays open
pending that runtime outcome and fresh normal backend coverage.

A separate inspection found that the upload helper disabled configured
proxies for external hosts despite a localhost-only comment. That observation
did not establish the admission failure's cause. The parent owns its separate
route-preservation correction; no system proxy, Freedom setting, or protected
service changed during this investigation.

The client correction scopes its direct opener to the parsed exact loopback
hosts `localhost`, `127.0.0.1`, and `::1`; external POST and visibility GET
requests now use urllib's configured default route. A compact actual-client
control failed on the original source (one failure, 0.08 seconds), then the
unchanged full Hub client suite passed all 23 tests in 3.06 seconds. It covers
external hosts, misleading loopback prefixes, and all three exact loopback
inverses without making external requests. The control is registered in the
normal benchmark blackbox suite. Five registered Hub controls also passed in
8.657 seconds, including original registration, ambiguous-commit recovery,
safe rejection and gzip transport behavior. These results verify routing
ownership and the standing instruction to preserve the user's network settings;
they establish no cause or performance claim for the production admission
failure. Private proof is `hub-owning-blackbox.safe.json` alongside the client
red/green logs in the same RCA evidence directory.

## Human feedback

The parent relayed the user's requirement that short infrastructure observation
windows should warn under the overall execution wall cap rather than create
false benchmark rejection, while final durable visibility remains mandatory.
This store repair does not alter those client observation semantics. The parent
required actual unchanged red/green evidence, preserved task/model/evaluator
definitions, normal coverage, an independent byte review, and production
backend rollout before the final fresh CLI proof.

## Reusable lesson

Admit same-process contenders before borrowing a finite database connection,
while retaining the cross-process fence required by the shared storage owner.
