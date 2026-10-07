---
id: 2026-10-07-terminal-startup-lived-as-queued-placeholder
date: 2026-10-07
title: Fleet live projection kept a completed startup failure queued during teardown
surface: harness
component: fleet-live-task-projection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet live aggregation seeds a queued row despite an authoritative child-finished marker and absent current task result
symptoms:
  - "benchmark-child.finished=125 while Hub status=queued and lifecycle_stage=teardown"
  - "terminal startup remained queued"
tags:
  - benchmark-hub
  - startup
  - live-publication
  - infrastructure-outcome
sources:
  - commit 681481df0425caf0a8d2157b872027b11a8ef8f9
  - fleet run 20261007-020659-75781
repro: agents/benchmarks/hub_upload_test.py::test_live_response_preserves_phase_and_startup_label_for_terminal_startup
status: open
---

## Problem

The original fifty-task batch remained correctly grouped, but one terminal
startup failure stayed `queued` and ungraded while labelled `teardown`.
The exact owned supervisor atomically wrote child exit 125 at epoch
1791364736.018749. That child had no current `cloudbench-run.json`, live child
card, accepted readiness marker, task execution or evaluation result. The
local batch card and production GET showed the same wrong row, so this was
not a browser-only display error. The original live control remains unchanged.

## Diagnosis

Critical path: the owned child supervisor joins its runner and atomically
publishes `benchmark-child.finished`; the existing live aggregation reads the
requested manifest and optional child card; `live_bundle_from_report_card`
projects that row through the normal Hub upload transport; the backend returns
the stored status and the unchanged benchmark component renders it.

The first bad data is local: aggregation seeded `status=queued` when no child
card existed, then used the completion marker only for lifecycle `teardown`.
Thus the result and lifecycle projections disagreed even after that child was
terminal. The completed whole-fleet aggregator already classifies an absent
current task result as `INFRA_ERROR`; live publication omitted the corresponding
per-child infrastructure terminal. This is a relative of September 9 terminal
artifact finalization and October 4 direct live publication, at a different
first-bad boundary: those repairs finalized whole-fleet artifacts and sent
existing evaluated cards; this path has no evaluated child card to send.

Archive searches were `benchmark-child.finished queued teardown INFRA_ERROR`
and `terminal startup failed report card ungraded publication`. Both related
cases' solution and human-feedback sections were read before the reproduction.

The new permanent six-state control executes the actual fleet aggregation and
normal upload client against the existing loopback Hub fixture. Frozen controls
on unchanged source produced 3 failures and 3 passing inverses in 3.83 seconds:
missing results after exit 125 or exit 0, and a stale queued card after exit 125,
all incorrectly remained queued. The same controls passed 6/6 in 3.93 seconds
after the correction. Existing real pass/fail rows and still-active children
remain unchanged. The complete owning Hub-upload suite passed 33/33 in 10.83
seconds. Source-relative Ruff, shell syntax and diff checks passed. Native
leaders and recorded subprocesses are joined and their absence is retained in
private hash-bound receipts.

The deepest owned gap is that resource completion and optional reporting data
were interpreted independently. Removing the required queued placeholder would
hide requested tasks; replacing the whole live pipeline is unnecessary. Reuse
the existing authoritative completion marker and canonical result boundary to
classify this terminal absence, without a timeout or task-name special case.

Golden references inspected: `claude-code-src/src/tasks/LocalShellTask/LocalShellTask.tsx:233`
publishes terminal process status from its completed result;
`openclaw/src/agents/bash-tools.process.ts:168` returns a finished session's
terminal status separately from process cleanup;
`hermes-agent/tools/terminal_tool_result.py:249` returns the actual process exit
code in its result envelope. These support surfacing terminal infrastructure
state without inventing a task evaluation. The local Codex reference tree was
unavailable; no reference code was changed.

## Solution

The existing live aggregator maps a still-nonterminal queued/starting/running
row to `error` when its joined supervisor completion marker exists and no
canonical current task result exists. The established Hub projection maps that
infrastructure status to `passed=false`; it supplies no agent ID, signed outcome,
duration or LLM-call count for the missing execution. Existing evaluated rows
and available canonical result files are not overridden. Final aggregation
continues using its existing `INFRA_ERROR` classification.

The four-line runtime change covers every requested task, including a process
that exits zero without producing a task result; process exit alone cannot earn
benchmark PASS. The owning control preserves the original fifty-name batch and
controller timestamp, plus real pass/fail and live-child inverses. Its name is
already selected by the existing `live_response_preserves_phase_and_startup_label`
normal compact deploy route. There are no backend/frontend changes, new
publishers, model calls, task/evaluator changes, budgets or native cleanup
changes. Work remains one existing O(tasks) aggregation pass with bounded local
file-state reads; at 10,000 tasks it introduces no nested scans or cloud calls.

This proves the local publication mechanism, not a repaired startup outcome or
new LIVE fifty-task acceptance. The unrelated MIGRATING start-ack failure has a
separate owner. No canonical paid benchmark or active production run was altered
or rerun. The case remains open until source-bound normal deploy and a fresh
production observation establish the corrected publication.

## Human feedback

The user requires one persistent fifty-task frontend group, accurate states,
and terminal grades before cleanup, while preserving generous stage endpoints
and overall bounds. Report a proven infrastructure failure accurately rather
than fabricate task execution, evaluation or LLM credit. Keep the healthy
current control unchanged and use compact permanent owning coverage.

## Reusable lesson

Project authoritative completed-child infrastructure failures into the live task view even when no evaluated child card exists, while preserving real task outcomes and their independent resource lifecycle.
