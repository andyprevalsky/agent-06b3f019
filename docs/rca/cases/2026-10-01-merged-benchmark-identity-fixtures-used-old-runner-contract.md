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

## October 2 integration recurrence: cleanup context import

A later pinned-main merge replaced the imported `ContextVar` alias with the
`contextvars` module while retaining the exact cleanup-owner variable. Four
existing benchmark identity/cleanup controls failed at module import with
`NameError: name 'ContextVar' is not defined`; the four Hub transport controls
passed. Syntax parsing alone did not catch this runtime name lookup.

Qualifying the retained declaration as `contextvars.ContextVar` restored the
existing cleanup-owner → task-user → environment → default precedence without
changing task behavior or deadlines. The unchanged compact control set then
passed all 18 cases: eight benchmark controls, nine Rose stream/cooldown
controls, and the cleanup cancellation fixture. These controls already run in
the canonical `/deploy` agents coverage gate; no additional suite was added.
The original failed launch remains archived. This merge seam result does not
claim a new fleet pass or resolve any unrelated latency cause.

## October 3 integration recurrence: task identity scope

The next pinned-main integration added a task-selection test that accessed
`_task_benchmark_user_id`, absent from the retained runner. The affected checks
passed workflow, DAG and error-utils, then stopped with 36 pytest passes and
this `AttributeError`, before benchmark coverage or its tail ran. Archive
searches were `_task_benchmark_user_id AttributeError` and `benchmark identity
context fixture`; the latter identified this fixture-contract recurrence.

Use the runner's existing `_benchmark_run_user_scope` for both siblings instead
of reaching into an alternate implementation's context variable. Preserve the
event ordering, both returned identities and the no-environment-mutation
assertion. The same isolated selector and environment failed in 2.077 seconds
before the fixture correction and passed in 1.518 seconds afterward. Only the
fixture changed; production identity precedence and cleanup remain unchanged.
The corrected selector is registered in the existing benchmark blackbox's owned
pytest group, alongside the existing test through real `run_single_task` calls.
It adds no new stage or subprocess and preserves the group's 60-second guard.
Private evidence is under
`.context/acceptance/proof118-task-identity-rca/`; the original failed affected
aggregate remains failed, and subsequent coverage completion is separate.
