---
id: 2026-11-03-benchmark-start-archive-blocked-mid-run-feedback
date: 2026-11-03
title: Required start archival delayed feedback observation beyond the background task window
surface: agents
component: benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: execute_agent awaited archive_agent_start before entering the time-sensitive _poll_agent feedback observer
symptoms:
  - "Declared evaluator smoke_feedback_while_explore_running failed: Mid-run feedback was never posted"
  - "Trace archive start fixture"
tags:
  - benchmark-runner
  - mid-run-feedback
  - trace-archive
  - cancellation
sources:
  - PR #1662
  - commit c492d7c5b814b988de307dd80f03f5241a3f71b5
  - commit 713f9cbf742f8efdac4274c4915d10c509bdff33
repro: agents/benchmarks/wall_clock_backstop_test.py::test_start_archive_pending_does_not_hide_background_feedback_window
status: open
---

## Problem

On frozen c492d7c5b814b988de307dd80f03f5241a3f71b5, background-agent-message-smoke agent 2d053e71-ffee-4a89-bb42-d69f3f95e215 completed in 40.7 seconds but failed its declared evaluator. The 180-second/75-cent task limits and all assertions remain intact. No task retry was run by the RCA investigator.

## Diagnosis

Gate: NOT_INTRODUCED for the observed awaited-archive-before-observation coupling, comparing 713f9cbf742f8efdac4274c4915d10c509bdff33 with c492d7c5b814b988de307dd80f03f5241a3f71b5. Repair and outcome validation remain OPEN. Historical full-check attribution beyond this reproduced defect and archive contention origin remain UNKNOWN.

The native POST /api/archive/agent-start took 24.946 seconds (03:45:37.428–03:46:02.374 UTC). The real background explore ran 03:45:43.152–03:45:53.180, entirely inside that wait. The first feedback poll already saw 24 root rows including completion, and correctly refused to treat the completed explore as currently running. No feedback POST was attempted.

Both immutable revisions' actual execute_agent ordering, extracted feedback decision and routing code reproduce the exact never-posted failure with captured transcript timing. Removing only the archive wait permits a post attempt at 10.392 seconds, while the captured explore is active. The private control replaces the remaining poll/network edges: root status/schema are controlled and post_message returns True without inserting a USER row. The strict evaluator correctly refuses that control as missing the row. This proves the ordering/trigger mechanism, not successful transport, forwarding, final marker assertions, or any benchmark PASS.

The registered feedback test calls _poll_agent directly with a still-active synthetic explore; it does not cover the earlier archive barrier. The existing explore-final-answer/inbox case is a related boundary, not this recurrence: here feedback was never posted at all.

## Solution

Start owned feedback observation without awaiting archival completion. Preserve required archival evidence and its joining, errors, cancellation and reaping. Add an owning orchestration regression that holds archival pending across a background task's active window. Do not retroactively post after completion, extend budgets, slow the child, or weaken assertions. No source fix or live validation was authorized in this evidence-only investigation.

## Evidence and cleanup

Private packet: /var/tmp/pr1662-c492-background-feedback-rca/report-v2.json, SHA256 bf0eaa435aa15000d4ec443dc9eecb77c94485441521b908eeb92758658dfb96. It binds the native result, backend span, transcript, immutable source exports, control harness and cleanup receipts. Independent review: /var/tmp/pr1662-c492-background-feedback-adversarial-review.json.

Native cleanup reports root deleted/tree sealed, stack clean, disposable cleanup evidence present, lifecycle verified and provider teardown verified. Machine 8654500b134238 is recorded destroyed-provider-retained, not absent. Parent retains all other task rows and active campaign ownership; no other outcome changed.

## Human feedback

Parent requested bounded read-only attribution, preserved original failure and task budgets, and prohibited provider/model/task retries, allocations, source/environment mutation or full gates. Those restrictions were preserved.


## Private implementation candidate

Parent subsequently authorized a bounded exact-c492 private implementation. The candidate keeps start archival and observation owned concurrently and joins both before returning, cancelling/reaping pending sibling work on errors or cancellation. It preserves archive HTTP failure/None behavior, the actual feedback poll, all evaluators and task definitions, 180-second/75-cent task limits, and the enclosing backstop.

The newly registered owning regression fails before the change while the archive blocks feedback observation; after the change actual execute_agent/real backstop/real poll posts with a mocked transport while explore is active, observes explore completion while archive remains pending, and waits for required archive release before returning. Raised archive/poll error and cancellation controls preserve propagation and complete asynchronous child cleanup. The owning wall-clock suite passes26/26 once. This is orchestration proof only, with external HTTP edges mocked and scoring deliberately not executed. No unchanged native task PASS is claimed; repair outcome remains OPEN pending parent integration/review/native rerun.

Candidate/proof: /var/tmp/pr1662-c492-background-fix/candidate.patch and report.json.


## Independent review correction and v2

The independent reader found the v1 sleep(0) cleanup check could miss a backstop cancellation leak: _run_with_agent_execution_backstop cancelled execution without awaiting the execution owner, allowing both archive/poll finalizers to remain active after that boundary returned. A new registered regression snapshots retirement and task completion at the actual backstop return before any outer finally or explicit test join, with 50ms asynchronous finalizers. It fails v1 (neither child retired), while v2 joins execution under the existing five one-second cancellation attempts before propagating the original clean exception; non-cancellation execution failures propagate. Deadline cleanup remains a separate original path, preventing duplicate grace. The final owning suite passes27/27 in3.11s. No production task timeout, price budget, poll interval or evaluator changed.

The initial new test assertion was inside the real task owner, so its expected failure entered diagnostics and attempted fixture.invalid DNS (failed; no provider response). The final identical before/after regression snapshots the boundary then asserts outside the owner, avoiding diagnostic IO. Final full replacement patchSHA16b9636bb3642885f407aea1f62a661df8558a4a857984d4883d6f2806f97d2a supersedes v1; report-v2.json retains limits. Parent owns integration/review/native validation; benchmark FAILED/OPEN remains unchanged.


## V3 cancellation during deadline drain

A second independent review found v2 moved deadline draining outside the cancellation guard: cancellation arriving during its wait could return while both child finalizers remained live. The final v3 candidate uses one explicitly owned cleanup task, with one monotonic grace end fixed at cleanup admission plus the existing five-second grace. Each of the existing five cancel attempts waits at most one second and never beyond that end. The parent shield-awaits this same task after repeated caller cancellation, records the original exception, joins cleanup, retrieves execution failures, then propagates the original clean error/cancellation. Cleanup failure remains an infrastructure error. No shielded cleanup task is detached on return and no cleanup budget restarts.

The registered actual-backstop test now covers both normal external cancellation and cancellation during deadline draining, with50ms child finalizers and a second outer cancellation10ms later. V2 fails with children unretired at the captured raw return boundary; v3 passes the owning suite28/28 in3.19s once. The v3 full replacement SHA8096285c770f8800f4658f78323c9a8fe0798c54c478904c94626834b53ba977 supersedes both earlier candidates. No native benchmark PASS is claimed; parent review/integration/native task validation remain required.

## Reusable lesson

Begin time-sensitive observation while required archival proceeds under the same task owner. Join both before completion and make cancellation draining resilient to repeated caller cancellation within one fixed existing cleanup grace. A focused orchestration test does not establish the unchanged native task outcome.
