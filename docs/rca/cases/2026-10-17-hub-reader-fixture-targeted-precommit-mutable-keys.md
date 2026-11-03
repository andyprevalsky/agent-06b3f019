---
id: 2026-10-17-hub-reader-fixture-targeted-precommit-mutable-keys
date: 2026-10-17
title: Hub reader compatibility fixture targeted precommit mutable keys
surface: infra
component: backend-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: benchmark-hub-reader-compatibility.test.ts assumed private staging committed claims and targeted retired mutable body keys
symptoms:
  - Hub run write has no private publication
  - Missing expected rejection.
  - pending claim must suppress legacy membership before the first new-domain agent index exists
tags:
  - hub
  - fixtures
  - blackbox
  - regression
sources:
  - commit c9ff323c3633f9c9a48b93693b06662d023896f1
  - commit 9152678f9d0e5910953626b052b5bd4e996634f5
repro: back-end/src/tests/unit/benchmark-hub-reader-compatibility.test.ts
status: open
---

## Problem

The C12 backend coverage run failed the Hub reader compatibility unit file and its registered blackbox entry. Captured original output reported an unstarted private publication, two missing expected rejections, an absent catalog document and legacy membership surviving an assumed pending claim. The original backend failure remains unchanged; other domain failures are outside this case.

## Diagnosis

Upstream commit9152678f9 changed publication to private immutable body/visibility/index objects and one catalog CAS. It added benchmark-hub-publication-commit.test.ts and documented that staged objects do not alter the acknowledged view before the catalog commits. The older reader compatibility fixture still wrote bodies without beginning private staging, injected failure/corruption into retired runs/id or visibility/id physical keys, and expected begin/hidden staging alone to publish a catalog. Those fixture actions no longer reached the contract being asserted.

Repository history binds the compatibility fixture to ef84eadc0 and the immutable production contract to9152678f9. Two symptom archive searches and the prior unlocked-index publication case were read; the latter is a consistency-boundary relative, not an identical recurrence. The deepest owned gap is fixture publication-phase and physical-object identity drift, not evidence of a broken production reader.

## Solution

Private test-only candidate begins private publication before staging a body, asserts direct unstaged writes remain rejected, and targets immutable keys selected by committed catalog pointers. A failed private body write must leave the previous legacy view and no catalog ACK; hidden claims are checked after the actual catalog commit. A literal valid existing-format pending catalog keeps backward-reader pending rejection and membership suppression coverage. Missing committed indexes and visibility/body corruption still reject without legacy fallback. CAS preconditions, legacy raw bytes, no per-run visibility scans, revision-floor checks, prototype safety and concurrent batch limits remain strict.

Offline replay of the same nine-test file and exact blackbox import reproduced five baseline failures and passed all nine candidate tests. The unchanged three-test atomic-publication golden also passed. Local controls deny real sockets, DNS and fetch and replace only the SQL advisory-transaction boundary; actor skeleton lookups are explicitly modeled as existing/live for the golden. These controls do not qualify actual PostgreSQL locking, cross-process DB state, provider acceptance or deployment success. The unchanged normal SQL-backed owning unit/blackbox gates remain required after ROOT application. Exact command wall times, source/test hashes, fixture limitations and preserved initial harness failures are in the private result.

## Human feedback

The user directed the deploy to completion without another runtime allowance question. The delegated worker produced a private candidate without tracked-source, VM, DB or provider actions. The parent reviewed and applied the fixture repair while preserving the active guest source and original failure evidence. No reader fallback, financial exception, prompt or timeout change is part of this repair. Historical failures and financial cleanup false remain preserved.

## Reusable lesson

When publication moves from mutable intermediate objects to a committed pointer snapshot, bind fault injection and corruption to the actual committed object identity. Preserve backward wire-reader coverage separately from obsolete writer intermediate-state assumptions. Do not restore obsolete runtime behavior merely to satisfy a stale fixture.
