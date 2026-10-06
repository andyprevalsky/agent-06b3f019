---
id: 2026-10-06-partial-hub-index-skipped-unknown-id-refresh
date: 2026-10-06
title: Partial Hub indexes returned unknown IDs before their cold refresh finished
surface: back-end
component: benchmarkHubLookup
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: findAgentAcrossRuns treated an installed incomplete map as a complete cold index
symptoms:
  - "expected 2 to equal 4"
  - "benchmark-hub-index-read"
tags:
  - hub
  - replay
  - index
sources:
  - commit 17cf59c7e
  - plan:docs/plans/active/wmh-local-continuation-20261006.md
repro: back-end/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
status: open
---

## Problem

After integrating main, the owning Hub index domain failed its unchanged refresh/backoff assertions. The WIP could install useful partial entries, but an unknown child read then started an unawaited refresh instead of joining the cold lookup. Background work also crossed adjacent fixture lifetimes.

## Diagnosis

What: readiness was inferred from map existence rather than completeness for the requested key. Where: `findAgentAcrossRuns` cold-load branch. Why: partial publication changed `childIdToRun` from null without establishing that a missing entry was authoritative. Proof: the full coverage runner recorded two owning assertions failing in `.context/wmh-backend-coverage-rerun.log`; the unchanged comma-separated `agent-trajectories,benchmark-hub-index-read` runner passed after repair. Problem: concurrent index readiness/backoff mismatch.

Archive searches used `partial Hub index unknown child backoff loadAllRunChildren` and `Hub replay incomplete index refresh concurrent reads`. September 12 multi-object publication and October 5 SQL lock admission are relatives, not this first bad boundary.

## Solution

Known entries in incomplete indexes remain immediately usable. Unknown entries join the existing coalesced cold refresh and its backoff. There is one shared refresh promise, no per-request archive scan, and constant-time key lookup at 10,000 agents. Full deploy coverage and production viewer verification remain pending.

## Human feedback

The user requires viewer-visible replay evidence; HTTP 200 and administrative access are insufficient.

## Reusable lesson

An incomplete index may answer known keys; it cannot make a missing key authoritative before its cold readiness boundary.
