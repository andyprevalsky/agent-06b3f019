---
id: 2026-10-30-sharded-coverage-fixture-inherited-heap-and-live-inventory
date: 2026-10-30
title: Sharded coverage fixture assumed clean heap inputs and a fixed live-domain count
surface: harness
component: backend-coverage-sharded-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The default report fixture inherited caller heap inputs, and its planner simulation used a growing live domain inventory for a strict cardinality assertion
symptoms:
  - merged c8 report must run with the raised heap
  - NODE_OPTIONS=--max-old-space-size=2300 --max-old-space-size=6144
  - heavy shard not relieved 122 120
  - wall-aware shard plan is wrong
tags:
  - fixture-isolation
  - node-options
  - coverage-shards
sources:
  - commit 9c30058e4deb8ee45c40596616b08d62e4a168e8
  - plan:.context/pr1634-sharded-heap-fixture-rca/report.md
repro: bash scripts/tests/backend-coverage-sharded.test.sh
status: fixed
---

## Problem

The frozen deploy structural gate failed at its default report assertion with parent Node2300 inherited; after isolating it, the same owning test exposed a separate live-inventory cardinality expectation failure. Production report helper correctly preserves caller options and appends the configured heap. Production planner balances parallel pool makespan plus serial exclusive time, not total domain count.

## Diagnosis

Private exact owning command before failed1.331s with original2300+6144. Heap-only candidate kept all assertions and reached a later failure122versus120 in16.843s; clean/customambient controls repeated it. The real planner and runner metadata hashes matched canonical source. No providers, databases or actual coverage collection ran. Archive searches used literal NODE_OPTIONS/coverage heap and behavioral inherited environment/fixture isolation, then heavy shard not relieved/wall-aware shard and fixture inventory/domain count. October15 backend Codex fixture path case is a relative, not this recurrence. No exact prior case found.

## Solution

Applied fixture-only repair: clear NODE_OPTIONS and BACKEND_COVERAGE_REPORT_HEAP_MB at test start; preserve explicit custom case. For planner scenario, supply15 controlled domain names, copy actual planner and actual runner phase metadata, fix this simulation pool at4, keep every existing coverage/uniqueness/cardinality assertion, and add a derived serial-wall assertion: code-preview250s gets no parallel work because the other14 bounded30s items fit in at most120s on four workers. The SAME full owning command passes on the artifact candidate after both fixes. Independent review additionally required an explicit synthetic expected set and supplementary real-inventory coverage. These are included: each weighted/unweighted real plan union is checked against the eligible filesystem list, with no duplicates or fragile cardinality assumption. The revised identical full command passes17.560s. Negative control privately ignores recorded weights and FAILS16.948s at unchanged fewer-domains assertion8versus7; planner restored afterward. Revised negative controls also reject a common synthetic omission16.670s and a real-only omission16.875s. Revised ignore-weights negative fails16.648s. Full default/customambient results are retained separately. Existing structural gate registration already invokes this test. Parent applied the independently reviewed patch and the actual owning command passed with inherited Node2300/report3072. Full deployment gates remain separately required; this case records the focused fixture repair, not deployment completion.

## Human feedback

Parent explicitly prohibited tracked edits while frozen pipeline active, required all original assertions/timeouts/thresholds, and authorized only artifact candidate and isolated proof. Parent expanded the same bounded RCA to the separately exposed planner-fixture boundary and required a distinguishing negative control. Preserve Freedom, jobs, leases and the separate pending HUMAN_REQUIRED review-ledger policy proposal.

## Reusable lesson

Own fixture inputs explicitly instead of deriving default expectations from caller environment or a growing production inventory.
