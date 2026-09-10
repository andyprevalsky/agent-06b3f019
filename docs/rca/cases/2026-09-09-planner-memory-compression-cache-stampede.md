---
id: 2026-09-09-planner-memory-compression-cache-stampede
date: 2026-09-09
title: Lazy planner-memory compression lacked an atomic single-writer lease
surface: cross
component: planner-memory-cache-fill
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/providers/plannerMemoryStore.ts critical-path claim
symptoms:
  - "concurrent cache misses could all invoke the compressor"
  - "winning compression claim must carry a lease id"
  - "exactly one of 100 claims must own compression"
tags:
  - planner-memory
  - cache-stampede
  - lease
  - concurrency
sources:
  - plan:.context/test-runs/1788986766-539673-8783/runner.log
repro: back-end/src/tests/blackbox/planner-memory.blackbox.ts
status: fixed
---

## Problem

Lazy compression originally performed `search -> R2 bundle read -> compressor
LLM -> PATCH cache` independently in every planner request. Concurrent misses
for the same popular row could therefore all pay for the same archive read and
LLM call. The risk grows directly with the 10k-agent target and was visible from
the absence of any ownership transition between the search response and cache
write.

The critical path was `planner retrieval miss -> backend search -> R2 read ->
compressor LLM -> backend PATCH`. The first missing invariant was at the backend
cache boundary, where no request could atomically become the sole writer.
Archive searches for `planner memory compression stampede`, `critical path
lease`, and `lazy cache fill duplicate` found no prior matching cause; novel.

## Diagnosis

The cache exposed only read and write operations. A read-then-write protocol
cannot exclude another caller between those operations, and in-process Python
locks would not coordinate multiple workers. The deepest owned cause was the
absence of an atomic database-backed state transition for a shared lazy fill.

## Solution

PlannerMemory now carries `compressionLeaseId` and `compressionLeaseUntil`. A
single conditional SQL `UPDATE` claims an empty or expired row for 30 minutes;
the API reports `claimed`, `busy`, `cached`, or `missing`. Only the lease owner
may PATCH the compressed path, failures release ownership, and successful writes
clear the lease. Retrieval claims before reading R2 or calling the LLM, so losers
skip all expensive work. Internal prewarm remains an explicit direct write and
also clears stale leases.

The permanent backend blackbox launches 100 simultaneous claims and requires
exactly one owner, rejects a wrong lease with 409, lets the winner fill the
cache, and observes `cached` on the next claim. `cd back-end && npx tsx
src/tests/blackbox/planner-memory.blackbox.ts` passed all 10 cases against an
isolated PostgreSQL database; exactly 1 of 100 concurrent claims became the
lease owner, and that lease case finished in 207 ms.

## Human feedback

None recorded.

## Reusable lesson

Protect distributed lazy cache fills with an atomic database lease acquired before any expensive work.
