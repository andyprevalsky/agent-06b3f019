---
id: 2026-10-15-curation-api-accepted-nonfinite-worker-count
date: 2026-10-15
title: Curation API accepted nonfinite worker counts
surface: back-end
component: trace-archive-curation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: curateTraceArchives applied Math.max and Math.floor without validating the exported API input
symptoms:
  - NaN concurrency returns an unfilled results array
  - Infinity concurrency starts one worker per bundle
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-curation/result.private.json
repro: back-end/src/tests/unit/trace-archive-curation.test.ts
status: open
---

## Problem

The actual exported owner under mocked archive dependencies returned 12 unfilled result slots forNaN and launched 12 concurrent workers forInfinity. The CLI already rejected these inputs.

## Diagnosis

Validation existed only in argument parsing, while the exported function trusted any numeric input. NaN becomes a zero-length worker pool; Infinity is bounded only by root count. Nonpositive values were silently clamped rather than rejected under the CLI contract.

## Solution

The API now rejects nonfinite values and values below 1 before allocation or archive access. Existing default 8, floor behavior for valid fractional values, input order and progress callbacks remain. The identical registered callback and owner controls failed baseline (exit 1, 0.249s) and passed candidate (exit 0, 0.115s) on pinned Node 22.13.0. A separate backend-gold/DEMO membership difference was documented but its policy change remains held: the existing corpus reader already rejects DEMO names. No actual archive curation/deletion or corpus contamination was proved.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `a1d2c8fe1540f96781fed91ecffdc145b93fd5ce96e806853f3612d4e77be302`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Validate exported worker-pool inputs before starting work even when the CLI already validates its own arguments.
