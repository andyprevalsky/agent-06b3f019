---
id: 2026-11-10-cancellation-fixture-required-unsealed-deletion
date: 2026-11-10
title: Group cancellation fixture required deletion after deliberately unsealed execution
surface: harness
component: cloudbench-multi-workstream-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: group_term_cancellation_contract calls a stale disposable deletion assertion after runtime capture was deliberately omitted
symptoms:
  - missing disposable runtime-evidence gap record
  - the failed group-TERM run did not retain its result while retiring disposable resources
  - refusing to destroy fleet machines whose runtime evidence is unconfirmed
tags:
  - cloudbench
  - cancellation
  - fixture
  - evidence
sources:
  - PR #1881
  - commit 615721fe772163f507e8a76da30a74df90bb7f95
  - fleet run 20261110-003357-61102
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: open
---

## Problem

Native cloudbench-controller multi-workstream exited1. The producer retained11 passing subcases and1 failed subcase; the outer occurrence remains incomplete and UNVERIFIED. The group-TERM cancellation scenario expected old disposable resource deletion despite deliberately unsealed runtime evidence.

## Diagnosis

The first failing test assertion is its exact grep for an obsolete deletion message. Later Python line11 in fleet_disposable_resources_terminal asserts the clone registry is empty, and correctly rejects the still-owned resources during a conservative capacity check. The fake driver intentionally suppresses the terminal run/seal after cancellation; guest ACK alone does not authorize deletion. Fixture source is identical at b5, ca404 and6157. Our ca404 preservation guard and log change introduced this test-contract mismatch; assigned repair remains owned.

## Solution

The source repair keeps production guards and all signal, latency, ACK and process-closure assertions. Replace the shared obsolete deletion helper with an explicitly unsealed assertion which preserves typed owner, published task verdict and failed lifecycle, then delegates to the existing strict retained-owner checker. Four sibling callers were inspected: pre-release metrics failures retain a failed task; pre-supervisor worker failures retain the completed primary PASS plus fleet failure. The separate post-supervisor captured-retirement branch stays unchanged. No synthetic accepted run or cleanup seal. Five offline repeats prove original helper rejection, candidate acceptance of retained state, and rejection for missing resource, destroy call or missing evidence latch. Native focused/full validation remains pending after parent review and integration.

## Human feedback

None recorded for this fixture repair. Existing instructions require preserving native evidence and all signal, latency, ACK and process assertions.

## Reusable lesson

When a cleanup safety repair changes unsealed ownership disposition, update the deliberately unsealed fixture to assert complete retention; do not generate fake evidence to preserve an unsafe deletion expectation.

## Local verification limits

The existing mandatory-metrics selector and the original remaining invalid-metrics, pre-supervisor worker and oscillation blocks passed against an external native fake-provider fixture. The captured post-supervisor retirement branch passed unchanged and left no fixture processes or Machines. Five unchanged helper rounds, negative controls and independent review passed. These scoped checks do not establish full controller acceptance; the selected registered gate must run on the new source.
