---
id: 2026-08-04-scheduled-wait-for-not-preserved-across-deploy-workflow-replacement
date: 2026-08-04
title: Pre-deploy cleanup terminated a live prod agent (versioned task queue defeated the "never touch prod" guard), so a scheduled wait_for fired ~9.4h late — NOT a timezone bug
surface: back-end
component: cleanup-stale-workspaces
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/cleanup-stale-workspaces.ts terminateStaleWorkflows — the "never touch prod" guard compared the full task-queue string with exact equality (queue === 'navi-agent-tasks'), missing the Temporal Worker-Versioning build-id suffix (navi-agent-tasks@ebdc7ba275e9)
symptoms:
  - "agent waited until 10am UTC instead of LA time"
  - "scheduled wait_for until_timestamp fired ~9 hours late"
  - "Deploy cleanup: stale workspace workflow"
  - "new code version deployed, retry this tool"
  - "prod agent workflow terminated by pre-deploy cleanup"
tags:
  - wait-for
  - scheduling
  - workflow-replacement
  - temporal
  - worker-versioning
  - deploy
sources:
  - agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc
repro: back-end/src/tests/unit/stale-workflow-queue.test.ts (guard) + agents/tests/blackbox/wait_for.blackbox.py (resume)
status: fixed
---

## Problem

A Rose agent was asked to schedule an iMessage to Andy Prevalsky for "Monday, August 3,
2026, 10:00 AM America/Los_Angeles." The user reported it "seemed like it waited until
10:00 AM **UTC** instead of LA time." The initial hypothesis was a timezone-conversion bug
in `wait_for`.

Prod evidence **refutes the timezone hypothesis** and identifies a different, more serious
defect: the scheduled send fired ~9.4 hours **late** because a pre-deploy cleanup terminated
the live prod agent mid-schedule.

## Diagnosis

Reconstructed from ClickHouse `observability.fly_logs` + the Temporal workflow history for
agent/workflow `e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc`.

1. **Timezone conversion was CORRECT.** The agent's reasoning: "10:00 AM LA is (-7), which is
   2026-08-03T17:00:00Z. Use `until_timestamp='2026-08-03T17:00:00-00:00'`" (= 17:00 UTC =
   10:00 PDT). The `wait_for` naive→UTC coercion branch (`agents/domains/wait_for/handler.py:92-93`)
   never fired — the value carried an explicit offset. Not the cause.

2. **Temporal history of the original workflow** (`temporal workflow show`):
   ```
   04:18:14Z  WorkflowExecutionStarted        taskQueue = navi-agent-tasks@ebdc7ba275e9
   04:19:39Z  TIMER_STARTED   id=1  fire=45621s
   04:20:17Z  TIMER_CANCELED  id=1
   04:22:49Z  TIMER_STARTED   id=2  fire=45430s   → due 2026-08-03T17:00:00Z (correct)
   16:03:50Z  WORKFLOW_EXECUTION_TERMINATED   reason="Deploy cleanup: stale workspace workflow"
   ```
   The scheduled wake timer (id=2) was armed correctly for 17:00:00Z, but the workflow was
   **terminated at 16:03:50Z — 57 minutes early** — killing the durable timer.

3. **Confirmed the terminator and that workers were up.** App-wide `fly_logs` volume held
   ~360–390k lines/hour across the entire gap (363,849 in the 17:00Z hour), so this was not
   a Fly idle-stop; other agents ran continuously. Agent-specific volume: 1545 lines at
   `2026-08-03T04`, **zero** until 194 lines at `2026-08-04T02`. The agent was resurrected on
   a different instance (`8de5…`) via the next deploy's replacement bootstrap
   (`e14d5abb…:replacement:027171a6…`), which force-closed the in-flight `wait_for` with
   `DEPLOY_INTERRUPTED_TOOL_MESSAGE` ("new code version deployed, retry this tool";
   `back-end/src/providers/workflowGeneration.ts:5`). The re-issued send-approval was created
   `2026-08-04T02:22:40Z` — **≈9.4h after the 17:00Z target.**

4. **First-bad boundary.** `back-end/scripts/cleanup-stale-workspaces.ts` is a pre-deploy
   routine (run from a local/CI machine, but connected to the **shared** prod Temporal
   namespace) that lists all Running workflows and terminates any whose task queue is not
   prod, not an isolated benchmark, and not an active Conductor-workspace queue. Its
   "NEVER touch prod queue" guard used **exact equality**: `if (queue === 'navi-agent-tasks')`.
   Prod workers register under Temporal **Worker Versioning** (`TEMPORAL_WORKER_BUILD_ID`), so
   `workflow.list()` reports the queue as `navi-agent-tasks@ebdc7ba275e9`. `'…@ebdc7ba275e9' !==
   'navi-agent-tasks'`, and it also fails `startsWith('navi-agent-tasks-')` (the `@` is not a
   `-`), so the prod workflow fell through to "Stale or unknown — terminate."

Deepest owned cause (problem class = fixture/environment/data mismatch): the cleanup's
prod/active/benchmark protection predicate matched the raw versioned queue string instead of
the **base** queue name, so the "never touch prod" invariant was silently false whenever
worker versioning was on. The same defect would wrongly terminate any **versioned
active-workspace** queue too (sibling failure).

## Solution

Extracted the queue-classification decision into a pure, Temporal-free module
`back-end/src/utils/staleWorkflowQueue.ts` (`classifyCleanupQueue` + `baseTaskQueue`) and made
every comparison run against the base queue name (`queue.split('@', 1)[0]`) — prod, isolated
benchmark, and active-workspace checks alike. `cleanup-stale-workspaces.ts` now consumes it.
This restores the "never touch prod" invariant under worker versioning and also protects
versioned active-workspace and benchmark queues (kills the whole class, not just prod).

Regression: `back-end/src/tests/unit/stale-workflow-queue.test.ts` asserts the exact incident
queue `navi-agent-tasks@ebdc7ba275e9` classifies as `skip-prod`. It **fails** on the
exact-equality guard (`actual 'terminate' - expected 'skip-prod'`, exit 1) and **passes**
after the fix (5/5, exit 0), unweakened. Auto-discovered by `scripts/run-unit-tests.ts` and
run under the back-end coverage gate on every `/deploy`.

Invariant audit (pass-over unchanged except the intended widening): the guard now compares
the BASE queue name, so — prod (bare `navi-agent-tasks` and versioned `…@buildid`), isolated
benchmark, and active-workspace queues (versioned or not) are all protected; genuinely stale
archived-workspace queues and fully unknown queues are still terminated. The change only adds
protection that was intended but silently missing under versioning; it never stops
terminating a queue that was terminated before. All five cases are asserted in the regression.

10k-agent behavior: pure per-queue string decision, no added fan-in, no shared state.

Defense-in-depth also shipped — resume the wait across a legitimate migration: a deploy that
replaces an active agent still tears down its `wait_for` sleep, so the replacement workflow
now re-arms it. `agents/domains/wait_for/service.py:pending_timestamp_wait_to_resume` (pure,
7 blackbox cases) reads the conversation and returns the original `untilTimestamp` of an
interrupted-but-not-completed timestamp wait whose target is still future;
`AgentWorkflow._resume_interrupted_wait` (3 wiring tests in `workflow.blackbox.py`) re-issues
`wait_for` against that absolute target on `_deployment_resume` before the LLM loop, so the
agent sleeps only the remaining delta and fires on time (or immediately if the target already
passed) instead of depending on the LLM to re-issue the wait. Determinism-guarded
(`workflow.*` primitives only; `workflow_determinism` blackbox passes).

Still not fixed (lower-priority, and no longer on the incident path): a local/CI pre-deploy
script can reach prod workflows at all because prod and workspaces share one Temporal
namespace — the guard is the only protection. Worth isolating namespaces later; the guard fix
closes the actual hole.

## Human feedback

User directed "yes reproduce dude" — reproduce the bug, not just theorize. The Step-7
adversarial review earlier forced pulling the real trace instead of accepting the timezone
theory, which is what refuted it and led to the Temporal-history evidence.

## Reusable lesson

A "never touch prod/<X>" guard that compares a Temporal task-queue name by exact string is a
lie under Worker Versioning — always classify against the base queue name (strip the
`@build-id` suffix) before deciding to terminate.
