---
id: 2026-07-14-benchmark-group-derived-in-code-diverged-from-stored-label
date: 2026-07-14
title: Benchmark "daily" group was derived in code, so the literal `group` field selected 2 tasks instead of 28
surface: harness
component: benchmark-catalog
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: hubCatalogService.ts:taskGroup() derived the daily group from tags/status while tasks.json carried an unrelated literal "group" field
symptoms:
  - filtering tasks.json on '"group":"Daily"' yields 2 phone tasks, but the Benchmarks page daily group has 28
  - a whole daily benchmark session ran the wrong task set
tags:
  - benchmarks
  - tasks-json
  - derived-vs-stored
  - catalog-drift
sources:
  - commit 2bc42274c
  - memory:project_daily_suite_concurrent_iteration
repro: none-recorded
status: fixed
---

## Problem

A prior session set out to run the "daily" benchmark group and ran 2 tasks. The
actual daily group is 28 tasks. The mistake came straight from the catalog: the
literal `"group":"Daily"` field in `agents/benchmarks/tasks.json` matched only 2
phone tasks, while the Benchmarks page's daily group was something else entirely.

## Diagnosis

Group membership had two disagreeing definitions. The authoritative one was
_derived_ in `hubCatalogService.ts:taskGroup()` — every `ready`, `pipeline-e2e`
task that is not `smoke`-tagged and not `rose-bench` — which enumerates to 28.
The `group` field physically present in `tasks.json` was a stale, unrelated
label. Anyone reading the catalog (human or agent) trusts the stored field, so
the derived-only contract guaranteed a wrong task set for any consumer that did
not read the frontend service code. The deeper owned cause: a selection contract
that lives only in derivation logic while a contradicting field sits in the data
file.

## Solution

Every task in `tasks.json` now carries a canonical lowercase `group` token, and
`hubCatalogService.resolveTaskGroup()` reads `definition.group` (normalized) with
the derivation only as a fallback; the seed propagates file → DB so the
Benchmarks page is driven off the stored label (commit 2bc42274c). Enumerating a
group is now a plain filter on the catalog, which is what every consumer already
assumed.

## Human feedback

The human corrected the scope directly: the daily group is 28 tasks, not 2 — the
prior session had keyed on the wrong field.

## Reusable lesson

If a selection rule is derived in code, write the resolved value back into the
data file — a stored field that disagrees with the derivation will silently
mis-scope every consumer that reads the file.
