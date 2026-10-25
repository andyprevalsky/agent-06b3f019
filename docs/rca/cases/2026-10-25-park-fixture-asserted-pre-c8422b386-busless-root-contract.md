---
id: 2026-10-25-park-fixture-asserted-pre-c8422b386-busless-root-contract
date: 2026-10-25
title: The auth park-measurement fixture's fake root lacked _background_tasks_write_lock and still asserted that a bus-less root stays ACTIVE
surface: agents
component: auth-test-site-benchmark-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/tests/blackbox/auth_park_measurement_fixture.py _pipeline binds the real AgentWorkflow._update_tree_state onto a SimpleNamespace without the state AgentWorkflow.__init__ creates, and asserts the old no_bus contract (ACTIVE, 0 tree activities)
symptoms:
  - "'types.SimpleNamespace' object has no attribute '_background_tasks_write_lock'"
  - "❌ root_park_measurement_uses_real_workflow_state_owner:"
  - "auth_park_measurement_fixture.py, line 69, in _pipeline ... asyncio.wait_for(park_ready.wait(),5) ... TimeoutError"
  - "auth-test-site-benchmark       FAIL"
tags:
  - auth-test-site
  - park-measurement
  - stale-fixture
  - background-agents
sources:
  - commit c8422b386
  - commit fb13d98e2
repro: agents/tests/blackbox/auth_test_site_benchmark.blackbox.py::test_root_park_measurement_uses_real_workflow_state_owner
status: fixed
---

## Problem

The `auth-test-site-benchmark` agents blackbox domain failed on HEAD d3abb07bd.
Exactly one test failed: `root_park_measurement_uses_real_workflow_state_owner`,
with a TimeoutError after "Browser manager failed ... '_background_tasks_write_lock'".
The other line in the domain output, "❌ browser-auth-created-account-reused:
FAILED - AuthTestSiteFirstRunFailed ... agent bcd9d7a7", is expected output
from `first_run_agent_failure_is_a_graded_task_failure`. That test replays the
real first-run failure as a fixture, and it passes. No live site, token pool
or cooldown was involved: every case in the domain uses fakes.

## Diagnosis

c8422b386 (2026-10-24, "a bus-less root persists explicit status transitions")
changed `AgentWorkflow._update_tree_state`. Without a bus, an explicit status
(PAUSED on browser auth-assistance) is now persisted through the tree-state
activity, under `self._background_tasks_write_lock`. `git blame` shows lines
5596-5600 come from that commit. The commit updated `workflow.blackbox.py`,
but not `auth_park_measurement_fixture.py`.

That fixture's `no_bus` mode binds the real `_update_tree_state` onto a
SimpleNamespace. It was last updated in fb13d98e2 (2026-10-22), before
c8422b386. It has two stale assumptions:
- It lacks the lock and `_persisted_background_tasks`. A real AgentWorkflow
  always has them: `__init__` calls `_init_background_state()`
  (agent_workflow.py:966, background_agents.py:160).
- It asserts the old contract: a bus-less root stays ACTIVE and runs 0 tree
  activities. Its activity stub even asserted that a bus exists.

The AttributeError aborted the browser handoff before the wait. `park_ready`
was never set, so the wait timed out. Production is unaffected.

## Solution

Fixture only; assertions are not weakened. The fake root now carries the
state AgentWorkflow.__init__ creates. Both modes now assert the current
contract: the root persists PAUSED through exactly one tree-state activity.
The persistence stub no longer requires a bus.

Red: the unchanged test fails on d3abb07bd with TimeoutError. Green: it
passes 5 of 5 times, and the full domain passes (25 tests, domain PASS).
10k agents: test-only change.

## Human feedback

None recorded. The parent relayed Andy's rule that token-pool exhaustion or
cooldowns are skips, not forced fixes. Neither applied here.

## Reusable lesson

When a fixture binds real workflow methods onto a fake, give it the state
`__init__` creates. A commit that changes a workflow contract must update
every fixture that asserts the old contract, so grep the method name across
tests/blackbox.
