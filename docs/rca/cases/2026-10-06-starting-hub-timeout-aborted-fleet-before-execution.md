---
id: 2026-10-06-starting-hub-timeout-aborted-fleet-before-execution
date: 2026-10-06
title: Starting Hub response timeout aborted a strict fleet and lost its terminal publisher
surface: infra
component: cloudbench-hub-publication-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: require_in_app_hub_visibility established its final publication owner only after a required starting POST acknowledged
symptoms:
  - one starting POST exhausted four transport attempts and aborted fifty controllers before task execution
  - identical initial packets committed repeatedly after the controller had already exited
  - sixteen canonical Hub rows remained starting after all fifty local task cards were errors
tags:
  - cloudbench
  - benchmark-hub
  - admission
  - publication
  - teardown
sources:
  - commit e33e3c94e285c5665f77b198c25e7bca3f1ac9c6
  - benchmark run campaign-20261006-115518-39717
  - fleet run 20261006-115526-39917
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_hub_transport_starting_snapshot_preserves_terminal_publication_owner
status: open
---

## Problem

The independent instructions-only CLI built and published an uncached image in
383 seconds and activated that exact image in 158 seconds. The following strict
fifty-copy campaign ended after 1,069 seconds with zero ready tasks and zero task,
cache or evaluator executions. The earliest failing outer controller exhausted
four thirty-second initial Hub POST attempts. Its cohort cancellation preceded
the generic canary-failed messages in the other waiting controllers.

Read-only backend runtime records show the exact initial packet stored four
times after the original controller's abort. The first observed commit was about
44 seconds after that abort; subsequent duplicates appeared over the following
seven minutes. Queried requests returned HTTP 499. No SQL pool exhaustion or
statement-timeout marker appeared in the collected window; this is a bounded
observation, not a claim about all production traffic.

An independent canonical API observer recorded 177 successful GETs and no
transport errors. At campaign termination plus a grace observation, 34 rows were
failed/nonlive while 16 remained starting/live, although all fifty producer cards
were errors. No task or resource-release acceptance credit was granted. The two
separate canary Machines were stopped after their allocation deadlines and remain
quarantined pending truthful release verification.

## Diagnosis

The controller set SELF_MANAGED_HUB_RUN and its parent run ID only after the
starting upload acknowledged. A transport timeout before that point aborted work
and prevented cleanup from publishing the same aggregate's terminal status.
Meanwhile, retries of the identical packet entered the serialized backend writer
as separate mutations. Visibility reconciliation returned 404 while the original
packet remained queued, so it could not prevent this amplification.

Archive searches included `hub registration ambiguous commit terminal publication`.
Related owners are the September 10 ambiguous-commit reconciliation case, the
August 12 local registration dependency case and the October 5 SQL admission
case. They do not justify declaring this campaign successful or weakening resource
ownership. Hub summary uploaded_at is computed before writer admission and is not
a commit timestamp.

## Solution

The fleet now retains its final-status publication owner before attempting its
starting write. One generous 120-second starting attempt warns on a transient
transport or retryable server failure and allows startup to continue. Missing
configuration, nonretryable client responses and unexpected programming errors
remain failures. Existing progress, terminal publication, durable acceptance and
exact-resource teardown contracts remain intact; normal task budgets are unchanged.

Independent review exposed two adjacent contract gaps. The underlying upload
helper could reconcile a programming error against a visible row; it now limits
reconciliation and retries to actual transient transport/server failures. One
permanent actual-helper control failed before this correction and passed with
unchanged test bytes afterwards. Cleanup previously warned on a failed required
final upload while retaining a success exit and lifecycle. Its existing owning
control now reproduces that error and passes unchanged after final publication
precedes lifecycle sealing. Publication failure makes the controller/lifecycle
fail without changing the task verdict or the physical teardown disposition.

The actual CLI/controller owner has three frozen timeout, server-failure and
authentication controls: all failed on original source and all passed after the
repair, with the same test bytes. Thirty-two affected Hub/controller functional
controls also passed. The new owner is selected by the existing compact deploy
control and the documented controller gate.

The backend coalesces only identical pending serialized packets within one storage
owner before SQL admission. A settled success or rejection evicts its entry;
distinct content, run identity, effective source and live mode keep the existing
admission order. PostgreSQL cross-process locking and the persistence body's
absorbing final state remain unchanged. The eight owning controls reproduce two
failures on original production and pass unchanged after the repair; their test
assertions are preserved through the minimal actual-helper loader wiring.

These source-owner reproductions do not prove that native fleet startup, global
catalog latency or complete resource cleanup is fixed. Actual deployment and a
fresh strict fifty-copy run remain required. Raw runtime records, request metadata,
original source, frozen tests and qualified receipts remain private under
`.context/hub50-live-timeout-20261006/` and
`.context/hub-identical-put-coalescing-20261006/`.

## Human feedback

The user permits infrastructure observation delays to warn, requires benchmark
execution and terminal results with truthful resource release under one overall
wall-clock bound, and wants compact permanent regressions through the normal CLI.
The requested cached diagnostic is separate from the already completed LIVE gate.

## Reusable lesson

Establish the terminal publisher's ownership before a starting-status transport
attempt. An ambiguously delayed write must not create repeated admissions or lose
the final status writer; acceptance still comes from actual execution and release.
