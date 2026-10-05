---
id: 2026-09-29-browser-cancelled-before-session-had-impossible-recording-requirement
date: 2026-09-29
title: Pre-session browser cancellation could not satisfy cloud archive recording requirement
surface: infra
component: cloud-owned-benchmark-browser-archive
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _refresh_browser_archive_snapshot required a recording for a canceled browser activity with no allocated session
symptoms:
  - "Cloud evidence finalization failed: TimeoutError"
  - "browser archive refresh exceeded its readiness bound"
  - "User paused the browser agent"
tags:
  - cloudbench
  - browser-recording
  - provider-ownership
  - teardown
sources:
  - PR #1299
  - commit 792f28df265c71620b1f4d7313f4bfcb4355edd7
  - fleet run 20260930-021348-29481
  - agent ca9d72bd-9e5d-4e08-ab4b-94c913c7116b
repro: agents/tests/blackbox/benchmark.blackbox.py
status: open
---

## Problem

Proof68's first ten-task cloud slice had nine ordinary evaluated tasks. The
tenth, `polar-odysseys-a931f7baacfd`, reached its real root and LLM calls but
became `ERROR` during cloud evidence finalization. The archive waited 60 seconds
and raised `TimeoutError`; the guest could not seal a trustworthy runtime
bundle. The slice received zero credit. The original 8 GB guest was stopped,
its 37 original files were preserved with a SHA-256 provenance sidecar, an
interrupted forensic archive was built with zero proof credit, and exact owner
`cda0a49051d547618b52f4a56e86afe5` was recovered before further runs.

## Diagnosis

The captured worker emitted `Agent paused after cost check with pending
tool_calls; dispatching before pause` at 02:21:35.044 UTC. The browser manager
posted `session_starting` at 02:21:35.248, canceled its activity at
02:21:35.284, and posted `task_complete` with `toolStatus=ERROR` and `User
paused the browser agent` at 02:21:35.362. The exact owned root's before,
after, and final database snapshots each contained zero `BrowserSession` rows,
including deleted rows. No session ID or recording event appeared in the
transcript. At the archive boundary, `_agent_messages_ready_for_durable_browser_evidence`
required a playable recording for that deterministic task ID, which a
pre-session cancellation cannot produce.

The archive search used the literal `owned cloud evidence finalization failed
TimeoutError browser archive recording cleanup acknowledgement` and the
behavioral `browser subagent remains active after root pause recording not
attached benchmark timeout cloud guest cannot seal evidence`. The September 11
cloud-archive case is related but had allocated browser sessions and late
recording writers; its strict recording rule still applies to those sessions.
This incident is a distinct pre-allocation boundary, not a retry or timeout
policy problem. The publisher correctly rejected the incomplete FE evidence.

## Solution

The archive now recognizes only the exact canceled-before-session transcript:
unscoped `session_starting`, a task-scoped `task_complete` `ERROR` with the
precise pause result, and no other browser lifecycle rows. It requires the
exact root tree to match and its database to contain zero browser sessions at
both the pre-archive and current archive reads. It persists a task/root-bound
zero-allocation receipt. The durable FE publisher accepts the absent recording
only when that receipt matches the original task ID and the root's before,
after, and final owned database snapshots and provider cleanup receipt all
prove zero sessions. Any allocated session, extra browser event, missing
terminal, changed tree, or missing receipt retains the existing fail-closed
recording requirement. Task prompts, evaluator, model behavior, and verdict
rules are unchanged. The added exact-root read occurs only for this unusual
cancellation shape, so normal ten-wide runs gain no extra query.

The permanent benchmark blackbox replays the captured two-message transcript.
Before the fix its unchanged command failed with
`TypeError: _refresh_browser_archive_snapshot() got an unexpected keyword
argument 'ownership_before'`; afterward it passed. The durable-publisher
regression failed before the fix because `verified_zero_session_tasks` was
absent, then passed. It also rejects positive session rows in any of the three
owned snapshots. The existing 27 cloud cleanup tests pass. An exact unchanged
local benchmark before/after outcome has not yet been established, so this RCA
remains open and does not claim the reported task is outcome-fixed. The next
real cloud run and full ten-slice streak are separate required evidence.

## Human feedback

The user required infrastructure-only repair, with no changes to benchmark
tasks, scoring, or model behavior. A normal evaluator `FAILED` is acceptable;
lost recording, untrusted FE evidence, or incomplete teardown is not. The
temporary five-minute task backstop and independent 30-minute end-to-end
cutoff remain in force for this validation.

## Reusable lesson

Distinguish a browser session that owes a recording from a tool call canceled
before allocation using exact owner snapshots, and never infer either state
from an error label alone.
