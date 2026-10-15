---
id: 2026-10-15-demo-cache-resolution-conflated-failed-lookup-with-resolved-state
date: 2026-10-15
title: Cache-context startup conflated failed lookup with resolved state
surface: agents
component: fast-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: resolve_fast_cache_context_activity omitted an explicit successful-root-resolution signal consumed by workflow startup
symptoms:
  - Failed cache-context lookup replaces restored decision
  - Restored DEMO cache disabled after failed resolution
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-transport/result.json
repro: agents/tests/unit/test_review_transport.py; agents/tests/fast_cache/test_fast_cache.py
status: open
---

## Problem

The actual workflow startup controls found that cache-context resolution needed to distinguish failed root lookup from an authoritative result, including a legitimate empty goal.

## Diagnosis

This is related to 2026-09-27-general-demo-cache-gate-was-never-loaded-by-workflow, but its first boundary differs: the lookup now runs; its success/failure authority was ambiguous. Truthiness cannot encode the distinction because an empty root goal can be a successful resolution. Failed lookup must not replace restored state.

## Solution

The activity emits an explicit resolved signal based on successful existing root identity; workflow startup preserves existing/restored decisions on failure and accepts an empty successful goal. The initial proposal used a Temporal patch. C4's unchanged migration gate rejected that branch because generation replacement forbids accumulated `workflow.patched` decisions. The corrected startup retains the resolved guard without that history branch. No DEMO eligibility criterion, cache namespace policy or model context was introduced. The shared transport/cache review batch went 9 FAIL / 12 PASS to 21 PASS; existing general-DEMO activity and metadata callbacks also passed. Full Temporal history replay and unchanged benchmark outcomes remain open.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `b059edbd21cb33aa4afe9618e707c0f49ec63f21788969507ee32a6e82c8497e`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Represent successful resolution explicitly instead of inferring authority from the truthiness of its value.
