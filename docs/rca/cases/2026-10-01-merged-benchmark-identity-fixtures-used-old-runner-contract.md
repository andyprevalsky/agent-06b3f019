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

## October 29 recurrence: Foundry speed and shared-authority fixtures

PR1634's merged Rose domain reproduced 279 passing and three failing checks.
Two cooldown fixtures passed the removed `provider_fast_mode` keyword to the
real `foundry_complete`, whose required argument is now `speed`. The Ultra
model-pin fixture intercepted HTTP without serving the shared cooldown
authority, so the real fail-closed route skipped Foundry before the model
assertion. These were fixture-contract mismatches, not production cooldown or
model-pin failures.

Pass `speed=None` in the cooldown cases and explicitly serve the fake shared
authority with exact method, path, authentication and deployment-key assertions.
Require that authority read and scope its local cache. All original cooldown,
200-route model-pin, serving-model and fallback assertions remain intact.

The first corrected run exposed a separate isolation dependency in the offline
opaque-reasoning timing control: synchronous context archive I/O consumed most
of its unchanged two-second bound. Disable context dumping only for that
mocked stream control; its five-second deadline, idle timeout and elapsed
assertion remain unchanged. This does not establish a production latency fix.

The identical command, `cd agents && venv/bin/python scripts/run_blackbox_tests.py rose`,
then passed 282/282 in 10.8 seconds, matching the original command and duration.
The intermediate 281/282 result is retained. Evidence and exact diff are under
`.context/rca-foundry-fixture-20261029/`; this focused pass does not replace
aggregate coverage. Searches covered the literal keyword failure and shared
cooldown mock contract; the October 20 deployment-cooldown case was related
context rather than a recurring production failure. The user requested fixing
the remaining deployment gates and explicitly skipped treasury only.

## October 18 SMS dispatch integration recurrence

Syncing PR1473 with main `c7fc3b3d2a282a93ee4d482fef813fe0c4148fdc`
made the existing SMS custody fixture reject the task before either committed-root
callback ran. Main deliberately shallow-copies the catalog task and resets six
native ownership fields for each execution; the older fixture instead asserted
`actual is task`. The first bad boundary was that fixture assertion, not the
production callback or cleanup path. This is the same stale-fixture problem class.

Archive searches used `on_agent_created custody sms dispatch unexpected keyword`
and `SMS runner cleanup root callback forwarding`. The full canonical benchmark
blackbox domain failed its SMS owning check. The identical isolated command,
`cd agents && python -m pytest benchmarks/sms_runner_test.py -q`, then reproduced
one failure and 134 passes on `a0ff098e011aa97399d5c323d457cb52f0e8cf99`.

Correct the existing fixture to require a distinct execution object, unchanged
task configuration, six fresh ownership fields and an untouched caller template.
Keep both duplicate committed-root observations and the exact single callback
assertion. The same isolated command passed all 135 tests in 2.31 seconds after
the correction. An independent review confirmed that no production code changed
and callback forwarding and deduplication assertions remain intact. This removes
an obsolete fixture assumption without changing runtime complexity at 10,000 agents.

The test stays in `sms_runner_test.py`, invoked by the existing permanent
`sms_runner_scoring_contract_permanent_gate` inside the agents benchmark blackbox
domain. The failed full-domain attempt is retained; only its failed SMS subset
was rerun. This proves the integration fixture correction, not a fresh canonical
SMS benchmark, full deploy pass or production acceptance. Private before/after
logs remain under `.context/tamy-resumed/sync-main-20261018/`.

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

## October 6 recurrence: pytest fixture discovery in the benchmark registry

The final `9d617bc3` covered benchmark registry discovered
`test_evaluated_wrapper_completion_publishes_once_before_owner_release` but
called it with no arguments. Its required `tmp_path`, `monkeypatch` and six
parameterized `path` variants therefore never reached their assertions. The
same owning variants already passed the normal compact pytest route. This is a
test-discovery boundary mismatch, not a failed publication or cleanup behavior.

The unchanged actual registry reproduced this TypeError alongside the stale
dependency count failure in 42.213 seconds. Discovery now detects required
parameters and delegates those cases to pytest through the existing owned
benchmark command helper. Pytest supplies fixtures and runs all six original
variants; the helper retains native process-group drain and the existing owning
domain guard. Parameterless functions and the existing asynchronous route keep
their original execution paths. The owning test function, its parameters and
assertions are byte-identical.

The same two covered registered families passed in 43.372 seconds; all six
callback variants ran through normal pytest and their original native owner
was absent afterward. The original whole-domain failure remains archived and
unchanged paid judges are retained separately. No new stage, runtime timeout,
model call or publication behavior is introduced. The final source-bound
coverage composition is recorded separately from this causal pair.
