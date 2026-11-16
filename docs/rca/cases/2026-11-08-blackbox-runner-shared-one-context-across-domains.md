---
id: 2026-11-08-blackbox-runner-shared-one-context-across-domains
date: 2026-11-08
title: Agents blackbox runner awaited every domain in one asyncio task, so a ContextVar bound by one suite leaked into later suites
surface: harness
component: agents-blackbox-runner
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/scripts/run_blackbox_tests.py run_single_domain imported and awaited each domain's run_all_tests() directly in the runner's own task and context
symptoms:
  - "❌ client_resolves_agent_speed_once: AssertionError: [None, None, None]"
  - rose 296/297 only when run after spawn-browser-agent-v3 in one runner process
  - python scripts/run_blackbox_tests.py spawn-browser-agent-v3 rose fails; rose alone passes
  - current_agent_speed() returns "standard" at the start of a later blackbox domain
tags:
  - blackbox-runner
  - contextvars
  - test-isolation
  - agent-speed
  - order-dependent
sources:
  - task descend-failed-neverrun-20261106 cluster I-39 (H-71b round-3 golden reviewer finding)
  - commit 0087e080c5b5a3b6039c90c72c9eddfdf6ceb80c (reproduced base)
repro: agents/tests/unit/test_blackbox_runner.py::test_sequential_domains_in_one_task_do_not_share_agent_speed
status: fixed
---

## Problem

A combined agents blackbox run,
`cd agents && python scripts/run_blackbox_tests.py spawn-browser-agent-v3 rose`,
failed `client_resolves_agent_speed_once` in the rose domain with
`AssertionError: [None, None, None]` (rose 296/297). The same rose domain passes
when run alone. The test expects the first two Ultra calls for `speed-agent` to
send `service_tier: "ultrafast"` from the agent row; every call sent none.

## Diagnosis

Critical path: `spawn_browser_agent_activity_v3` →
`_spawn_browser_agent_activity_v3_real` / `_simulated` →
`bind_agent_speed(await resolve_agent_speed(agent_id))` (handler.py, unbalanced
set; unknown agents resolve to `"standard"`) → `_CURRENT_AGENT_SPEED`
(`providers/rose/speed.py`) → `RoseClient.complete` (`providers/rose/client.py`),
which uses a bound speed and skips the agent-row lookup when one is set.

1. The rose test fails exactly when a speed is already bound. Scratch replay
   `/var/tmp/h71b-r3-scratch/speed_leak.py`: `prebind=False PASS`,
   `prebind=True FAIL [None, None, None]`.
2. Why was a speed bound at the start of rose? `run_single_domain` imported the
   domain module and `await`ed `module.run_all_tests()` in the runner's own task.
   ContextVars set by one domain therefore stayed set for every later domain. The
   runner already cleared structlog context, mock handlers and `os.environ`
   between domains, but not ContextVars generally. New regression
   `test_sequential_domains_in_one_task_do_not_share_agent_speed` failed on base
   with `[('binding-speed', True, ''), ('observing-speed', False, '')]`.
3. Is the handler's unbalanced bind also a production leak? No. Temporal's
   activity worker starts each activity with
   `asyncio.create_task(self._handle_start_activity_task(...))`
   (`temporalio/worker/_activity.py:160`, temporalio 1.34.0), so each activity
   runs in a copied context. A real time-skipping Temporal worker with
   `max_concurrent_activities=1` ran bind("fast") → observe → bind("ultrafast")
   → observe and returned
   `['before=None after=fast', 'observed=None', 'before=None after=ultrafast', 'observed=None']`.
   The worker loop context stayed `None`. The only production caller is
   `workflow.start_activity(spawn_browser_agent_activity_v3, ...)`.
4. Deepest owned cause: the runner did not give each domain the isolation it
   assumes ("each domain must begin with the same ... context ... as an isolated
   process"). It reset known state families by hand instead. The agents package
   defines about 20 module-level ContextVars, including demo-cache context, span
   runtime context, secret log refs, stream progress and resume details. Any of
   them could leak the same way.

Sibling inside the rose domain: `test_flash_root_explore_compute_only_and_speed`
restored with `bind_agent_speed(previous_speed)`. That turns `None` into
`"standard"`, so every later rose test ran with a bound speed. A reorder would
have failed `client_resolves_agent_speed_once` with no other domain involved.

## Solution

`run_single_domain` now imports the domain and runs `run_all_tests()` in a
per-domain `contextvars.copy_context()` (`ctx.run(exec_module)`, then
`asyncio.create_task(run_all_tests(), context=ctx)`). This is the same task-scoped
isolation Temporal gives each activity, so no ContextVar a suite sets can reach a
later suite. It prevents the whole class for every ContextVar, not only agent
speed. The existing structlog, mock-handler and environment resets are unchanged.
The rose speed test now restores with its token (`token.var.reset(token)`).

No production change: the handler's binds are already task-scoped in the worker.
10k-agent behavior: unchanged. This is test-harness only, with one extra asyncio
task per blackbox domain.

Regression:
`agents/tests/unit/test_blackbox_runner.py::test_sequential_domains_in_one_task_do_not_share_agent_speed`.
It awaits two domains sequentially in one task, as `run_tests` does. It runs in
`tests/unit` under `agents/scripts/run-coverage.sh`, which is the /deploy agents
coverage gate.

Verification, all run in an isolated worktree at base `0087e080c5`:

- Before the fix, `python scripts/run_blackbox_tests.py spawn-browser-agent-v3 rose`
  failed: `❌ rose FAIL (296 passed, 1 failed)`, `Results: 1 passed, 1 failed (258.1s)`.
- Before the fix, the new regression failed:
  `AssertionError: [('binding-speed', True, ''), ('observing-speed', False, '')]`.
- After the fix, the same combined command passed:
  `✅ rose PASS (297 passed)`, `Results: 2 passed, 0 failed (251.0s)`.
- After the fix, `python scripts/run_blackbox_tests.py rose` passed 297/297.
- `pytest tests/unit/test_blackbox_runner.py` passed 13/13 in each of 5
  consecutive runs.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

When a test runner executes several suites in one interpreter, run each suite in its own copied context (task) instead of resetting known globals by hand, and before patching a production ContextVar bind, prove whether the production scheduler already gives each unit of work its own task.
