---
id: 2026-11-10-coarse-flaky-unit-lost-nested-pytest-definition
date: 2026-11-10
title: Coarse flaky benchmark unit could not bind its actual failed pytest definition
surface: harness
component: deploy-flaky-native-definition-binding
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: validate_attribution matches a domain unit against the nested pytest function name
symptoms:
  - no quarantine marker for benchmark in agents/benchmarks/code_bench_test.py
  - a completed native pytest failure cannot bind its narrow in-definition marker
tags:
  - deploy
  - quarantine
  - flaky
  - evidence
sources:
  - PR #1915
  - commit 9905809a46e392997e834801a3c7adce87267a10
  - plan: .context/rca-playwright/benchmark-flake/findings.json
repro: scripts/tests/deploy-test-quarantine.test.py::NativeDefinitionBinding.test_original_single_native_definition_binds_without_rewriting_unit
status: fixed
---

## Problem

The agents-coverage gate reported the benchmark domain FLAKY: its first run
failed and its single automatic rerun passed on the same source. The first
native pytest failure was the existing test_commit_fixture_rewritten_history_fails,
which encountered a disappearing .git/objects/maintenance.lock while creating
an archive. The actual writer and maintenance trigger remain unknown. The
same archive boundary reproduces on the baseline and candidate implementation;
seven relevant source files are unchanged. Gate: NOT_INTRODUCED for this
additional archive failure, independently of the passing rerun.

Three other labels in the domain's failure detail are intentional nested
negative controls whose owning test passed. They are not independent failures.
Both native attempts and the original coarse unit benchmark remain retained.
The archive repair itself is a post-merge autonomous repair; the assigned
Playwright production startup repair remains owned here.

## Diagnosis

A narrow marker belongs on the actual failed pytest definition. The attribution
matcher instead compares that function name to the domain unit benchmark.
Adding the correct marker therefore still fails qualification. Quarantining
the whole domain or rewriting its recorded unit would lose the native scope.
Archive searches and active-thread work were compared by actual failure
boundaries; an independently reported gather/finalizer cancellation failure
is distinct from this Git archive race.

The existing quarantine suite's new positive regression reproduces the mismatch
against the original source before applying the binding repair. Golden reference:
not applicable to this operational evidence contract.

## Solution

Bind an explicit nested pytest definition to its original canonical round,
gate, source, token, recorded worker receipt and plan worker root. Verify the
localized original first-attempt log against the captured worker output and
hashes, and require exactly one native FAILED definition and its verbatim error.
Match only that definition's marker and retain the proof under its attribution.
Other formats, missing or mismatched evidence and multiple failures stay blocked.
Original grades, attempts, outer unit and source records are never rewritten.

A retained proof is revalidated, including document hashes, before it can keep
qualifying the original occurrence. Normal directly named test attribution
continues through its existing path. The original failed command ran the entire
pytest file; the repair packet names that command and the concrete failed node
separately. The permanent positive regression first fails against the original source.
Independent review then reproduced four additional rejection gaps; new owning
controls reproduce them before correction. The corrected full existing suite
passes 20 tests, including the original 19 negative subcases, malformed lineage,
contradictory worker flags, unrelated pytest errors and retained-proof drift.
Current plans may refresh; immutable originating attempts and captured requests
remain checked. Final source-bound gates and production verification remain required.

## Human feedback

None recorded.

## Reusable lesson

Preserve coarse native outcomes while binding a narrow exception to the actual
executed failed definition through immutable source-bound evidence.
