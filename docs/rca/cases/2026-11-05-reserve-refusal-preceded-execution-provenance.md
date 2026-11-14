---
id: 2026-11-05-reserve-refusal-preceded-execution-provenance
date: 2026-11-05
title: Cleanup reserve refusal preceded fleet execution provenance
surface: harness
component: cloudbench-preallocation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: reserve_cleanup_disk_space could terminate the producer before it wrote execution-provenance.json
symptoms:
  - insufficient physical cleanup floors for pending controllers
  - native cleanup noncanonical proof file execution-provenance.json
tags:
  - deploy
  - cleanup
  - provenance
sources:
  - commit f87a389979fd30826a1b133cb445cc0f648d3536
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_native_preallocation_refusal_preserves_failure_and_hub
status: fixed
---

## Problem

The exact e92 cloud attempt failed cleanup-reserve admission. Two controllers
reported the refusal; the campaign stopped its peers. All ten lacked final
execution provenance, and canonical cleanup refused the missing evidence even
though resource audits were empty. The retained Hub remained owned. Dead PIDs
and empty resource lists cannot substitute for producer source authority.

## Diagnosis

The producer freezes full execution configuration after snapshot and dependency
preflight, but reserves cleanup disk earlier. Moving the full configuration
block would capture values before they are resolved. The previous controller
intentionally allowed native preallocation teardown without execution provenance;
the higher-level cleanup validator had no matching authenticated contract.
The new synthetic native cleanup fixture fails against the original validator
at its missing provenance check. A shell fixture executes the actual reserve
boundary with a deterministic ENOSPC refusal and no provider implementation.

## Solution

Freeze the existing complete workspace patch before reserve admission. Write a
separate immutable preallocation identity with source, base/patch, ordered task
matrix, verified controller snapshot, exact fleet owner and native process birth.
An actual reserve refusal or a terminal interruption still before resource
admission writes a matching abort record. Immediately before the first pool
reconciliation, write a resource-admission marker that disqualifies this path.
Full runtime provenance is still created by its original later block.

Canonical cleanup accepts the early identity only with the exact producer source
present in the original commit, matching receipt/owner/source/base/patch/matrix,
valid clocks, no live controller, no resource-admission or runtime markers, and
all existing lifecycle, resource-audit and retained-Hub checks. It changes no
failed outcomes and grants no test credit. Original e92 records are not amended;
they remain unsupported by this future-only protocol. Provision-pool maintenance
keeps its existing path.

## Validation

Registered worker and cycle tests cover source ordering, actual reserve refusal,
write-once identity, wrong owner, post-admission refusal, missing or changed
proof, runtime markers, immutable failed outcomes and retained Hub ownership.
No provider, financial, database or live cloud actions are used.

## Human feedback

User requires original receipts to remain intact and explicitly distinguishes
future producer repair from unresolved historical cleanup authority. No disk
floor, concurrency, timeout or gate may be relaxed.

## Reusable lesson

A producer can fail before its final execution configuration exists. Give that
boundary its own narrow source-bound evidence; never reconstruct historical
execution authority from a dead process or an empty inventory.

The legacy compatibility fixture also now restores its declared historical
inventory helpers alongside its historical producer. Using current guard
helpers with the old source label correctly failed strict source comparison;
the fixture repair preserves that comparison and its negative cases.

Independent review found that mutually consistent sidecars were not enough:
late-added records could otherwise qualify. The adapter now hashes both early
records and original native ownership metadata into its original result. Cleanup
requires those exact original hashes and compares controller PID/start against
the native owner metadata, not just between sidecars. Retrospective-sidecar and
self-consistent forged-birth controls fail on the previous implementation and
pass after these checks, without granting any historical e92 authority.
