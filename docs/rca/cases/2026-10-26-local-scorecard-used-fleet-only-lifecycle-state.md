---
id: 2026-10-26-local-scorecard-used-fleet-only-lifecycle-state
date: 2026-10-26
title: Local scorecards discarded native running status at the fleet adapter
surface: harness
component: cloudbench-scorecard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: load_fleet mapped local nonterminal rows using only the absent fleet lifecycle_stage
symptoms:
  - Native report-card running tasks render IP0 and QUEUED
  - HTML validator returns valid while logical progress is wrong
  - Experiment UNRECORDED is shown without a ledger launch
tags:
  - local-scorecard
  - state-normalization
  - lifecycle-stage
  - report-card
sources:
  - commit 0dfadfb1247083a3ea7c20b96a8a941520384c65
  - plan:.context/rca-local-scorecard/findings.txt
repro: python3 scripts/tests/cloudbench-scorecard.test.py Scorecard.test_local_active_card_uses_native_status_without_lifecycle_stage Scorecard.test_fleet_explicit_lifecycle_stage_keeps_precedence_over_status
status: fixed
---

## Problem

The local smoke and payment benchmark scorecards rendered running tasks as
queued. Original screenshots showed IP0 and all QUEUED while native rows had
status running and agent IDs. Frozen later snapshots reproduced the same
boundary: smoke native queued5/running2/completed1 rendered queued7/IP0/completed1;
payment native queued2/running1/completed1 rendered queued3/IP0/completed1. Both
HTML validators returned no problems. These snapshots are separate observations
from the earlier screenshots, not claims of simultaneous counts.

Evidence is retained under .context/rca-local-scorecard: the unchanged native
smoke-report-card.json and payment-report-card.json, before.log, after.log,
registered-before.log, registered-after.log, suite-after.log and final.patch.
The actual local benchmark controllers remained running throughout this RCA.

## Diagnosis

The local producer at agents/benchmarks/run_benchmark.py:17302 emits running
only for admitted, unevaluated occurrences. It writes per-task status without
fleet lifecycle_stage. scripts/cloudbench-scorecard.py:373 supports both local
and fleet report cards. At line455 its adapter handled terminal local status
but used only lifecycle_stage for nonterminal rows, defaulting to queued. This
was the first bad boundary; classify at line174 and finish_experiment at line312
then correctly rendered and counted the already-wrong normalized rows.

The shared adapter incompletely normalized two supported input contracts. The
existing local regression at scripts/tests/cloudbench-scorecard.test.py:457
covered only terminal rows; the generic task fixture at line46 defaults to a
released lifecycle_stage, hiding the absent-field case. Local is explicitly
supported by the module docstring and .claude/shared/report-display-format.md:128;
that contract requires actual logical task counts. The HTML validator at line1381
checks display structure and cannot establish source/count correspondence.

Before hypothesizing, archive searches used local scorecard running queued
report-card and scorecard state mapping queue in_progress. The case
2026-10-06-pending-benchmark-futures-reported-as-running is a relative, not this
incident recurring: it repaired scheduler admission in the producer. That
producer is correct here; the downstream adapter discarded its state.

Golden references were independently searched and opened: claude-code-src/src/
components/TaskListV2.tsx:115 uses explicit bgTask.status to identify active
teammates; hermes-agent/hermes_cli/kanban.py:507 renders task.status directly;
openclaw/packages/agent-core/src/agent.ts:730 updates pending work from explicit
start/end events; codex/codex-rs/exec/src/event_processor_with_jsonl_output.rs:477
maps ItemStarted and ItemCompleted notifications separately. These are state
normalization analogs, not identical benchmark scorecard implementations.
Searches included status/running/queued, pending tools and item start/end. The
contrary local practice is fleet lifecycle state: verdicts can arrive before
teardown, so task.status alone cannot replace that contract. The repair preserves
explicit fleet stages and terminal/cleanup handling; agent existence is never
used as a state proxy.

Experiment UNRECORDED is separate. ledger-evidence.json records no launch
matching either run in the actual shared ledger. build at line852 and _rate_text
at line1046 intentionally expose that absence. The display contract at
.claude/shared/report-display-format.md:156 requires real launch receipts and
excludes local diagnostics from invented experiment counts. No ledger event,
experiment count or provenance enhancement was added.

## Solution

After the coordinating agent reported the immutable review closed and authorized
the narrow tooling repair, preserve the existing stage map and normalize absent
local lifecycle_stage from its native status at one adapter boundary. Explicit
lifecycle stages retain precedence; cloud fallback behavior remains unchanged.
This unifies the existing input contracts without a second counter or new state
machine. Deleting fleet lifecycle handling would break teardown semantics.

The registered owning tests add local running/passed/queued rows with omitted
and null lifecycle_stage, a queued row with an agent ID, and a conflicting cloud
status/stage control. Both local cases failed on unchanged renderer source;
after the one-line fix the identical command passed two tests in 0.008s. The
unchanged captured-native replay failed for both lanes before, then passed in
0.007s with the native counts preserved. The full existing scorecard suite,
registered as benchmark-scorecard in scripts/run-deploy-structural-gates.py:119,
passed all41 tests in 1.257s. git diff --check passed. All logs and exact commands
are in findings.txt; production/runtime code, benchmark definitions and running
controllers were untouched. Parent owns combined checks, refreshed cards,
independent acceptance and archive reindexing; no deployment was attempted.

## Human feedback

The coordinating agent required a five-minute independent RCA, read-only while the immutable
review was open, no child agents or live provider actions, and a narrow proposed
repair to the scorecard and owning tests. They required separating state mapping
from optional experiment-ledger enhancements. Afterward the coordinating agent
reported review closure and authorized this repair and its own archive case,
with no INDEX edits. This authorization is attributed to the coordinating agent.

## Reusable lesson

Normalize each supported producer's explicit state at the shared adapter and test native nonterminal shapes without lifecycle fixture defaults.
