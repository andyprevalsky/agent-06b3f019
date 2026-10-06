---
id: 2026-10-01-zero-allocation-producer-rejected-terminal-shutdown-suffix
date: 2026-10-01
title: Zero-allocation proof producer rejected a valid repeated shutdown suffix
surface: infra
component: cloudbench-zero-allocation-proof
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: validate_zero_backend required exactly one shutdown line while the canonical cleanup verifier accepted a terminal shutdown suffix
symptoms:
  - "backend evidence has no complete exact-root lifecycle boundary"
  - "repeated-terminal-shutdown"
tags:
  - cloudbench
  - recovery
  - zero-allocation
  - shutdown
sources:
  - PR #1299, CodeRabbit comment 4152321198
  - commit 393ebef7cddfdf624d57bb5f0525ad8dca236418
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_quiesced_guest_writes_hashed_authoritative_zero_allocated_receipt
status: fixed
---

## Problem

Late review identified different terminal-lifecycle contracts in the actual
zero-allocation producer and cleanup verifier. The owning CLI reproduction
rejected a complete exact-root backend log ending in two shutdown messages;
its two existing single-shutdown controls passed. This is a reproduced recovery
defect, not attribution of an earlier live failure to repeated shutdown.

## Diagnosis

Archive searches covered `zero allocation repeated shutdown lifecycle producer`
and `zero backend SIGTERM terminal suffix`. The existing status-service and
runner-receipt cases establish exact terminal ownership, but do not repair this
producer/verifier mismatch. The canonical cleanup helper already explains that
a second SIGTERM may be logged while the same backend is closing.

The producer required exactly one shutdown line. The verifier required one
start before a nonempty terminal suffix of shutdown lines. The public
`prove-zero-allocation` call therefore failed before issuing its exact query.
The unchanged owning fixture failed one case and passed two in 3.179 seconds.

## Solution

Match the existing canonical suffix predicate: require one start before the
first shutdown, at least one shutdown, and only shutdown lines afterward.
Exact-root binding, UTF-8 validation, provider-allocation rejection, authoritative
query, root deletion, receipt hashes, and forensic validation remain unchanged.

The identical three-case fixture passed in 2.377 seconds. It exercises the real
producer CLI, recovery receipt validator, and forensic consumer. Five existing
negative controls also passed, preserving rejection of ambiguous database
identity, incomplete lifecycle, provider allocation, and browser-session mutation.
Ruff lint passed. Full-file formatting checks already failed on both baseline
files; the new parameter block matches Ruff formatting without unrelated churn.

## Independent review and archive

Raw artifacts and immutable RED/GREEN receipts remain private under
`.context/acceptance/proof85-terminal-owner-rca/`. Independent root review passed
the source, identical RED/GREEN fixture, and strict negative controls.
The fixture uses an isolated fake SQL boundary, no real providers or model calls,
and grants zero benchmark credit. No execution budget or task result changed.
The final deploy gates and consecutive live fleet proof remain pending.

## Human feedback

The user requires zero infrastructure failures and exact cleanup, with compact
owning regressions rather than additional broad verification suites.

## Reusable lesson

Keep a recovery proof producer and its consumer aligned on the same terminal
lifecycle without weakening resource or exact-owner evidence.
