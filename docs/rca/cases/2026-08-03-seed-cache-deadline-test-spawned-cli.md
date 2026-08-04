---
id: 2026-08-03-seed-cache-deadline-test-spawned-cli
date: 2026-08-03
title: Seed-cache request-deadline test coupled the network contract to TypeScript child startup
surface: harness
component: backend-unit-test-runner
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: back-end/src/tests/unit/seed-dump-cache.test.ts spawned the CLI to test the imported S3 request deadline
symptoms:
  - "R2 deadline test never reached the hanging endpoint"
  - hanging R2 endpoint respects request deadline failed
tags:
  - seed-dump-cache
  - r2
  - request-timeout
  - child-process
  - test-harness
sources:
  - PR #924
repro: back-end/src/tests/unit/seed-dump-cache.test.ts
status: fixed
---

## Problem

The canonical backend unit coverage run passed the six synchronous seed-cache
cases but failed the final hanging-endpoint case with `R2 deadline test never
reached the hanging endpoint`. The test spawned Node plus the `tsx` CLI and then
asserted that its in-process HTTP server had observed a request. The child output
and exit code were captured but omitted from the failure, so the precise child
exit reason is not recorded. The unchanged focused test passed after the full
fan-out ended, which is consistent with host scheduling or child-startup
contention but does not establish the omitted child exit reason.

## Diagnosis

The contract under test was `S3Client` aborting an open local response at the
configured 250 ms request deadline. Starting another TypeScript process, loading
the module graph, and reporting its lifecycle were unrelated prerequisites. A
delay or early exit anywhere in that child path surfaced only as the downstream
`requestObserved` assertion. The first bad boundary was therefore the test
coupling a request-handler invariant to process startup; the deepest owned cause
was unnecessary asynchronous fan-out plus an observability gap around the child
result.

## Solution

The cache `get` operation is now exported and the test invokes it in-process
against the hanging HTTP server. It still proves that the server received the
request, the client-owned deadline fired before a two-second harness backstop,
and the lookup failed closed, but no longer makes TypeScript child startup part
of the assertion. The focused test passed all seven cases afterward. The export
does not alter CLI behavior; the test removes a process and adds no production
work or 10,000-agent cost.

## Human feedback

None recorded.

## Reusable lesson

Test a request deadline at the request boundary, not through an unrelated child-process startup path.
