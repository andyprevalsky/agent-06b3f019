---
id: 2026-07-21-trace-archive-mode-read-late-by-async-job
date: 2026-07-21
title: Async trace-archive job read the backend mode at drain time, so an env change let a local job drain the R2 outbox
surface: back-end
component: trace-archive
classification: our-bug
problem_class: other
first_bad_boundary: the async trace-archive job resolved the archive backend mode when it ran instead of capturing it when the job was submitted
symptoms:
  - a local-mode trace-archive job drains the R2 outbox
  - trace-archive behavior depends on when the async job happens to run
  - archive destination changes mid-flight after a configuration change
tags:
  - trace-archive
  - r2
  - async-race
  - configuration
  - benchmarks
sources:
  - PR #847
repro: back-end/src/tests/blackbox/trace-archive.blackbox.ts
status: fixed
---

## Problem

Deploy verification surfaced a configuration race in the trace-archive path: an
asynchronously submitted job could observe a _different_ archive backend mode than
the one in effect when it was submitted, so a job intended to run locally could end
up draining the R2 outbox.

## Diagnosis

The job read the archive backend mode lazily, at execution time, rather than
capturing it at submission time. Between submission and execution the environment
can change (a mode switch, a differently-configured process, a benchmark run
flipping `TRACE_ARCHIVE_BACKEND`), and the job then acts on configuration it was
never intended to run under. Any async worker that resolves its own configuration
late is non-deterministic by construction — the outcome depends on scheduling, which
is exactly why this only appeared under gate verification rather than in normal use.

## Solution

Snapshot the trace-archive backend mode **when the async job is submitted**, so a
later environment change cannot redirect an in-flight job, and added a
deterministic regression test that reproduces the race. This generalizes to any
deferred work in the archive path: the submitter's configuration travels with the
job instead of being re-derived by the executor.

## Human feedback

None recorded.

## Reusable lesson

Capture environment-dependent configuration at the moment work is enqueued, never
when it is executed — a deferred job that re-reads config can act on a mode nobody
asked it to run under.
