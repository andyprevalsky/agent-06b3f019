---
id: 2026-09-11-seed-copy-protocol-and-late-child-completion
date: 2026-09-11
title: Combined COPY command rejection was hidden by a late child-close subscription
surface: back-end
component: seed-jsonb-stream
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/seed-jsonb-stream.ts runCopyStream target command framing and completion
symptoms:
  - unexpected COPY_IN result, aborting connection
  - LocalStorageOrigin fidelity mismatch
  - Node beforeExit code 0 with unsettled COPY
  - Browser Provider Profiles synced without subsequent Cookie completion
tags:
  - postgresql
  - copy
  - child-process
  - lost-event
  - cold-seed
sources:
  - PR #1299
  - commit 81e79b450258687795af9271798101c3e2ea73c8
repro: back-end/src/tests/blackbox/seed-origin-paging.blackbox.ts
status: fixed
---

## Problem

After source restore was repaired, all five cold seeds exited zero immediately
after Browser Provider Profiles. Each had zero LocalStorageOrigin rows versus
3,739 source rows. The independent fidelity gate correctly failed with rc86;
these low, incomplete RSS readings were never counted as passing measurements.

Observed child-process traces are retained in
`.context/acceptance/cold-seed-resume-rca/psql-events.jsonl`. In every run the
target psql printed `unexpected COPY_IN result, aborting connection` and closed
with code2 before the source closed with SIGPIPE. Node then emitted beforeExit0.
No CSV rows, credentials, or connection URLs were captured by that observer.

## Diagnosis

The path was source COPY stdout → backpressured Node pipe → target COPY stdin →
transactional merge → row-count marker → completed seed. Two owned contracts
failed. First, all target statements, including COPY FROM STDIN, were supplied
as one psql --command. A real local TEMP-table reproduction failed with
psql16.15 code2 and passed with the same statements as repeated --command flags.
The identical single/separate control both passed on psql17.6. This isolates a
client-sensitive protocol boundary; no client downgrade or version branch is
needed. PostgreSQL documents repeated command options on the same connection:
https://www.postgresql.org/docs/18/app-psql.html.

Second, runCopyStream subscribed to target close only after source/pipeline
completion. The earlier target event was lost, leaving an unresolved promise;
a promise alone does not keep Node alive. An independent fixture using the
exported streamCookies and two real subprocesses deterministically observed
target close before releasing the source. Node exited0 with settled=false.
The earlier partial-source rollback repair held stdin open correctly but did
not capture early target completion, and its SQL/backpressure tests never
executed that process boundary.

Searches for `LocalStorageOrigin fidelity target zero`, `seed-local tsx stale
cache incomplete`, `unexpected COPY_IN result`, and `seed COPY target close
pending` found no same-cause archive entry. The July23 unpaged-origin and
August19 seed-memory recurrence are relatives, not evidence for this mechanism.
Git history showed no existing fix for the two boundaries. Hypothesis fields
and client controls are recorded in
`.context/acceptance/seed-copy-exit-rca/hypothesis.json` and
`real-psql-protocol-before.json`.

## Solution

Target SQL is represented as complete statements and passed through repeated
--command flags on one psql process and connection. Explicit BEGIN and COMMIT
retain atomic staging/merge semantics. No SQL string is split on semicolons.
Both subprocess completion handlers are registered immediately after spawn,
retain spawn errors, and resolve on close without an early rejected promise.
The source must succeed before target stdin receives clean EOF; any source or
pipe failure still kills the owned target mid-transaction. Both child failure
diagnostics are retained so derivative source SIGPIPE cannot hide target error.

This removes two implicit lifecycle assumptions instead of adding client
fallbacks, retries, or new deadlines. The existing two subprocesses and pipe
backpressure remain constant per seed table. No row is materialized in Node;
no shared lock, polling loop, or agent-count fan-in is added at 10,000 agents.

The permanent owning blackbox contains success, early target failure, source
failure/no-clean-EOF, and target spawn-error subprocess cases. It also executes
the actual generated target SQL through local psql using only session-local
tables and asserts CSV quote/newline/semicolon fidelity. Before the fix,
`node --import tsx src/tests/blackbox/seed-origin-paging.blackbox.ts` failed
three assertions (17/20 passed). The same command passed20/20 after the fix.
Evidence: `permanent-before.log` and `permanent-after.log`. Existing SQL checks
only join the newly structured commands for their unchanged content assertions.

The suite is discovered by the existing backend blackbox runner in /deploy.
Independent review approved the boundaries and independently reran the original
subprocess reproduction: success resolves7 and early target failure rejects
with its diagnostic, with both processes closed. The actual unchanged five-cold
command, `bash scripts/measure-seed-memory.sh 5 0 0 --enforce-budget`, passed
all five fidelity comparisons with peaks154,155,155,156,154MB against the
unchanged230MB limit. Evidence: `cold-seed-after.log` and
`.context/seed-mem-41619/summary-41619.txt`. All eight exact source/target
databases from the four measurement attempts were independently confirmed
absent after cleanup. This provides no cloud acceptance credit.

## Human feedback

The user requested continuing to completion without repeated permission checks,
retaining 120-minute normal backstops and a temporary five-minute acceptance
limit. No limits, benchmark criteria, client versions, or credentials changed.

## Reusable lesson

Represent protocol stages explicitly and capture subprocess completion when each process starts, before awaiting other processes.
