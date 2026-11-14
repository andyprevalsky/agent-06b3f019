---
id: 2026-11-10-chat-capture-tests-added-literal-sync-sleeps
date: 2026-11-10
title: Capture repair fixtures fail main fixed-sleep ratchet
surface: back-end
component: archive-late-manifest.helper.ts and llm-stream-archive.cases.ts
classification: test-bug
problem_class: concurrency-inefficiency
first_bad_boundary: c34e2e01 introduced literal synchronization sleeps rejected by main zero baseline
symptoms:
  - "AssertionError: 1 != 0 : FAIL: test files added fixed literal sleeps used as synchronization:"
  - "RatchetCase.test_current_tree_passes"
tags:
  - fixed-sleep
  - condition-wait
  - archive-ownership
sources:
  - PR #1905
  - commit c34e2e01c3c1bf1edf4435f69dc794eb3dd2cd02
repro: python3 scripts/tests/condition-waits.test.py
status: open
---

## Problem

Gate: INTRODUCED relative to main 58be9c28730a39033034853167a2a8c0cd686c65. Frozen 510 source failed native sub-suite twice and independent local reproduction once. REPORT.md retains exact evidence and clocks.

## Diagnosis

First bad test producer c34 adds 25/25/2ms synchronization sleeps. Unchanged pre-sync test bytes do not waive the new main ratchet. Main detector and baseline are unchanged in frozen source.

## Solution

Replace elapsed-time synchronization with observed enrollment of the held root and dynamically registered child writers. Keep direct terminal finalization, original error-cause assertions and durable payload/manifest checks. Control the actual producer input clock for reversed completion order and assert recovered start timestamps. The unchanged sleep ratchet passes all 15 tests; both existing archive and stream-contract domains pass. All four fault-injection controls fail with the unchanged owning assertions: removed terminal drain, unawaited drain, single pending snapshot, and finish-time archive clock. Each production file is restored byte-for-byte. Final source-bound deployment remains required. No baseline, deadline, concurrency or task assertion changes.

## Human feedback

User required read-only RCA, reports only in this directory, no recursive agents and no paid/live/localDB suites. Rejected baseline increases, disabling, quarantine, disguised sleeps, zero-turn substitutes, weaker pending observations, provider-data mutation and replaced original errors. Parent owns code and deploy; original task PASS/publisher FAIL and missing original context remain unchanged.

## Reusable lesson

Observe the real ownership join or control the producer input clock, retaining exact failure-identity and reversed-completion negative controls.
