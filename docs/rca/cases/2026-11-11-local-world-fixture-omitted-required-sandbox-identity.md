---
id: 2026-11-11-local-world-fixture-omitted-required-sandbox-identity
date: 2026-11-11
title: Local world fixture omitted the verified Sandbox identity required by the native launcher
surface: harness
component: local_worlds_test native services manifest fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The mocked services manifest lacked agentcard_world_identity before actual apply_manifest_environment validation
symptoms:
  - Native payment world has no verified sandbox AgentCard identity
  - Local fixture world isolation failed
tags:
  - benchmark
  - local-world
  - fixture-contract
  - identity
sources:
  - commit a5085083a51997a460a39fb8dd480ddacba70a52
  - plan:.context/agentcard-stability/review1-benchmark-fixture-contracts/manifest.json
repro: Recorded worlds-fixture-config-before.json and worlds-identical-after.json command
status: open
---

## Problem

The real a508 benchmark blackbox failed all four local fixture-world cases before reaching their expected agent boundary. Retained child logs show the actual native launcher rejected the mocked services manifest for missing Sandbox identity. These are private fixture controllers and HTTP servers; no provider or production database is involved.

## Diagnosis

With the canonical fixture configuration present, the unchanged local-world test reproduces that rejection. An early private attempt without test configuration was retained as invalid setup, not causal proof. The private candidate supplies the required version, exact run/world ID,64hex fixture scope, provider usr identity, sandbox mode and company-flow source. The identical command then passes all four cases and32 existing assertions in15.463 seconds;11 adjacent local-world controls pass. Searches for missing native world identity and local fixture Sandbox scope found the October20 fixture deadline case as a different cause: no deadline change is needed here.

## Solution

Only the mock manifest is updated. Actual local.py validation remains unchanged, as do same-user writes, independent world ownership, backend/database/queue isolation, overlap, cancellation and cleanup assertions. Identity values are deterministic fixture values, not forged provider observations or live setup. Independent review accepted exact fixture patchaf17e40fccab1dccdb2cfa20c8527c73758763d683c59c421f560a84d4db217a. Final-source integration and full agents gate remain pending; this is not new native payment proof.

## Human feedback

Preserve strict criteria, original failures, billing ownership and known no-remint restrictions. No new case-specific human feedback was received.

## Reusable lesson

A fixture driving the real launcher must produce its current identity contract before asserting later scheduling and cleanup behavior.

