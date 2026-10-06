---
id: 2026-10-06-pending-benchmark-futures-reported-as-running
date: 2026-10-06
title: Pending benchmark futures were reported as running before executor admission
surface: agents
component: benchmark-live-report-producer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: main_async uses pending futures rather than admitted executor occurrences as the running report source
symptoms:
  - Three queued copies report running three while a one-slot scheduler admits one executor
  - An early evaluated repeated occurrence leaves an unadmitted waiter marked running
  - A callback invoked from a child task needs the admitted occurrence's root link
tags:
  - benchmark-live-results
  - semaphore-admission
  - occurrence-ownership
  - early-outcome
  - cleanup-custody
sources:
  - PR #1420
  - commit 729ffeab590e703bc54d2cb34c86c18500250eb9
repro: agents/tests/blackbox/benchmark.blackbox.py through the normal benchmark domain
status: fixed
---

## Problem

Actual normal CLI report cards counted pending futures as running, including
copies waiting for a semaphore. The Hub projection preserves each reported
status and the benchmark view renders it. This observation proves the producer
bug. It does not prove what an authenticated production browser displayed:
the available browser runtime returned no connected browser.

## Diagnosis

The first bad boundary is main_async's pending-future Counter. A future exists
before the batch, browser, SMS and payment guards admit its executor. Agent
creation is also an unsuitable admission test: admitted work can legitimately
run before or without a created agent. Repeated names require per-occurrence
ownership, including callbacks that execute inside a child asynchronous task.

Archive searches for report-card running pending futures and benchmark semaphore
queued admission live status found the direct-fleet live-results case as a
relative. Its first bad boundary was publication transport, rather than the
producer's scheduler state. Preserve its early-verdict and cleanup contracts.

The owning reproduction executes the actual nested producer, parallel
coordinator and real semaphore scheduler. Only the external task executor is
event-gated. On frozen source, three copies with one admitted executor reported
running three and queued zero. With one repeated copy evaluated, one active
executor and one waiter, it reported completed one, running two and queued zero.
Both controls failed against the original source and passed against the private
repair using identical assertions. They require no network or model calls.

Independent review also exercised callback-created roots followed by an
executor exception through the actual batch finalizer. Reusing and clearing the
lifetime cleanup map for transient report links lost both allocated roots. The
revised proposal preserves the original cleanup map and its all-root callback,
and keeps per-occurrence display state separately. Frozen original cleanup
prepared and released both roots; the first proposal prepared neither; the
revised candidate again prepared and released both. Original evidence remains
private rather than being replaced with recovery receipts.

## Solution

Track each owning asynchronous task when it enters _run_reported_task after
admission guards. Bind its display root through a closure so a callback from a
child task cannot attach to a different occurrence. An evaluated PASS or FAIL
retains its verdict while teardown continues and suppresses that exact owner
from the running rows. Completion, exceptions and cancellation remove only the
transient admission/display association. The unchanged lifetime cleanup map
keeps every callback-created root, including composite and interrupted runs.

The existing report-card builder derives aggregate counts and queued placeholder
rows from these corrected occurrence rows. No task, model, evaluator, cache,
execution backstop, scheduler limit, publication acknowledgment or resource
release contract changes.

Permanent controls belong to the existing benchmark blackbox domain, which
/deploy Step4g discovers and runs automatically. Their event-failure backstops
are ten seconds; successful event-driven controls finish immediately. The final independent review accepted the revised source and all five focused
controls, including both original scheduler controls. The actual normal benchmark
domain exited zero in 176.8 seconds with all three new registered controls
passing, and repository-path Ruff passed. This closes the owning producer bug.
Production deployment and the requested fifty-copy stress run remain separate
from this source-bound producer proof.

```bash
cd agents
source venv/bin/activate
python scripts/run_blackbox_tests.py benchmark
```

## Human feedback

The user requested accurate benchmark-view states and immediate PASS/FAIL before
teardown. They also required liberal infrastructure deadlines, compact permanent
deploy controls, genuine unchanged grading, and a fresh-context validator using
only basic CLAUDE.md CLI instructions. Preserve Freedom and all proxy settings.

## Reusable lesson

Derive running from executor admission, bind display links to each occurrence,
and preserve all-root cleanup custody independently of transient display state.
