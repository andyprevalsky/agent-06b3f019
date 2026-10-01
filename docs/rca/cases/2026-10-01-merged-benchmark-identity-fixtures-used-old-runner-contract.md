---
id: 2026-10-01-merged-benchmark-identity-fixtures-used-old-runner-contract
date: 2026-10-01
title: Merged benchmark identity fixtures used an older minted-runner contract
surface: harness
component: benchmark-identity-fixtures
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: two incoming identity fixtures rejected the existing on_agent_created keyword before reaching their identity assertions
symptoms:
  - "fake_run_minted() got an unexpected keyword argument 'on_agent_created'"
  - "test_benchmark_user_scope_covers_preflight_errors_and_default_tasks"
tags:
  - merge
  - fixture
  - benchmark-identity
  - cleanup-owner
sources:
  - PR #1299
  - commit e6e4cd7a7b195fb4884000c42d935d0d224cb6e6
repro: agents/tests/blackbox/benchmark.blackbox.py::test_parallel_benchmark_user_scope_keeps_approval_auth_on_task_user
status: fixed
---

## Problem

Integrating main before the fresh fleet campaign added two task-identity tests.
Both failed with an unexpected `on_agent_created` keyword when run against the
merged benchmark runner. These were offline fixture failures, with no live
benchmark allocation or acceptance credit.

## Diagnosis

The real runner forwards its creation callback to minted-task execution and
sets `world_model_mode` on the returned result. The incoming fakes accepted only
three positional arguments and returned a dictionary or string. They modeled
neither part of that existing interface, so they could not exercise identity.
Independent review identified the mismatch; actual execution reproduced both
keyword failures. Archive search was `merge fixture runner keyword result
contract`; the September 30 sealed-artifact fixture case describes the same
class of incomplete successful-stub contract.

## Solution

Accept the keyword in both fakes and return mutable result objects carrying the
same observed headers or user ID. Keep the original identity values, concurrency
ordering and preflight assertions. Both tests then pass and remain registered
in the existing benchmark blackbox domain. Private before/after evidence is in
`.context/acceptance/proof96-main-identity-blackbox-{red,green}.private.log`.

The merge also preserves both production identity scopes: exact cleanup owner
takes precedence over task identity, followed by the environment and default.
The existing cancellation regression now uses a distinct task context to verify
owner selection, unaffected sibling requests and restoration after cancellation.
The cleanup and task-selection selection passed 45 tests. No new test framework,
live calls, timeout relaxation or weaker identity assertion was introduced.

## Human feedback

The user requested compact, robust benchmark-runner verification and avoiding
unnecessary campaign resets. Integrate and verify main before binding the final
100-task campaign source.

## Reusable lesson

After merging runner changes, make fixture inputs and result shapes match the
real call boundary before trusting their behavioral assertions.
