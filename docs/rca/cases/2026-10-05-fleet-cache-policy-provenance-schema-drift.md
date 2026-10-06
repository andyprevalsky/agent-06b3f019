---
id: 2026-10-05-fleet-cache-policy-provenance-schema-drift
date: 2026-10-05
title: Fleet emitted cache policy fields that its execution provenance schema rejected
surface: harness
component: cloudbench-provenance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet emitted two cache policy fields absent from cloudbench_execution_provenance.py's scalar allowlist
symptoms:
  - fleet creation rejected fast_mode_cache_disable_write_through before launch
  - benchmark_demo_cache_read_only was also absent from the schema
  - concurrent workstream fleets exited before freezing execution provenance
tags:
  - cloudbench
  - cache
  - provenance
  - schema
sources:
  - commit eb0a41fe1bfa68547594cf1c57a399a0522028a5
  - task canonical cloudbench-multi-workstream deployment gate
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_cloud_fleet_provenance_is_staged_stamped_aggregated_and_validated
status: fixed
---

## Problem

The complete multi-workstream controller gate reached fleet creation and both
workstreams rejected `fast_mode_cache_disable_write_through` as an unrecognized
provenance key. The fleet producer had added that field and
`benchmark_demo_cache_read_only`, while the strict consumer still declared its
older scalar vocabulary. Even an empty value is validated, so this rejected
ordinary fleet creation as well as the requested cached run.

## Diagnosis

The failed controller receipt remains private under
`.context/deploy-runs/20261006-024302-65153/`. Calling the actual `build_config`
with each emitted assignment reproduced rejection for both keys. The existing
exact emitted-key equality control also failed without changing its assertion.
The failure was at the producer/schema boundary before any task execution.

Archive searches covered the literal rejection, execution provenance, scalar
allowlists and configuration schemas. The private-source recovery parser case
has a related vocabulary-drift lesson, but its owner metadata and guest recovery
boundary are different; its recovery repair does not fix this config parser.

## Solution

Add exactly the two emitted cache policy names to the existing scalar allowlist.
Keep the provenance version, hashing, immutable snapshot binding, and rejection
of unknown or sensitive configuration unchanged. The same two assignments then
serialize their exact values under `cloudbench-fleet-config-v1`.

The existing emitted-key equality control and strict nonsecret-parser and
stamp/aggregate/validate roundtrip controls cover this boundary. Their shared
fixture now supplies both actual policy assignments and checks stored values.
The existing unknown-key, secret-like-key and opposite-provenance rejection
assertions remain strict. Register these existing quick controls in the compact
deployment gate so future producer changes cannot escape this contract.

The original full controller attempt remains failed. After the schema repair,
the unchanged controller passed both concurrent workstreams with distinct exact
source snapshots and the default detached controller cleanup. Its next failure
was the separate consumed-status assertion scanning earlier durable monitor
receipts, after the waited controller itself completed successfully. Final
owning controller verification and affected agents coverage remain required
before deployment.

## Human feedback

Keep regression coverage compact and relevant. Repair the exact schema mismatch
without weakening sensitive or unknown-key validation.

## Reusable lesson

A producer's new operational field must meet its strict downstream schema in an
existing permanent control before a live fleet is launched.
