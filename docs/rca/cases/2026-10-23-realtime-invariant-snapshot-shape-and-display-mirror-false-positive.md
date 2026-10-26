---
id: 2026-10-23-realtime-invariant-snapshot-shape-and-display-mirror-false-positive
date: 2026-10-23
title: Benchmark no-hanging-tool invariant misread the DB message shape and code-agent Display mirrors as model turns
surface: harness
component: benchmark-realtime-monitor
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/realtime_monitor.py NoHangingToolCallsInvariant — reconcile_snapshot fed agent-detail rows (`message`/`file_pointer`) to a check that reads realtime keys (`text`/`filePointer`), and handle_insert had no exemption for excludeFromModel Display rows
symptoms:
  - "Realtime invariant failed: assistant message d644b589-e1f6-4d0e-9a0a-e37a92d1b995 followed unresolved tool wait_for"
  - "followed unresolved tool wait_for (call_28e5a1c2e820437b8a4fd2b73a9c7995, IN_PROGRESS message 65f48acb-09c8-4324-b81d-2d6e4234bc08) with no FINISHED/ERROR state"
  - "followed unresolved tool spawn_claude_code_agent"
  - browser-smoke REAL CHILDFAIL while the wait_for FINISHED row exists in the DB
tags:
  - realtime-invariant
  - benchmark-evaluator
  - browser-smoke
  - agent-display
  - artifact-only
sources:
  - agent cddadfb3-2a5a-4782-9653-afdb4202fdee (sharded run original600-1792795636260090257 job r004-j0049, source 7eb275b1b)
  - commit 8678b59f2 (artifactOnly exemption, realtime keys only)
  - commit fc6989d58 (code-agent Display mirrored into the parent conversation)
repro: agents/tests/blackbox/realtime_monitor.blackbox.py::test_snapshot_reconcile_reads_api_message_shape_for_child_artifacts and ::test_code_agent_display_mirror_during_open_tool_is_not_parent_turn
status: fixed
---

## Problem

browser-smoke r004-j0049 failed with "assistant message d644b589… followed
unresolved tool wait_for (call_28e5a1c2…, IN_PROGRESS message 65f48acb…)". The
tool lifecycle was in fact correct: the wait_for FINISHED row 7d64da6d was
written at 23:17:20.631Z and broadcast (realtime frame 23:17:20.671). d644b589
and e5e5caf9 are the browser child's screenshot rows (`artifactOnly: true`,
empty text, file pointer) that the parent conversation receives just before
wait_for wakes.

## Diagnosis

1. run_benchmark only reports a realtime failure after `reconcile_snapshot`
   confirms it against the agent-detail messages.
2. The live monitor tripped first on row 4011c420, the parent mirror of a
   running code agent's Agent Display (`source: display`, `excludeFromModel`,
   `displayedBy.kind: code_agent`, fc6989d58). It landed while
   spawn_claude_code_agent was still open, which is the intended design: the
   display rows never split a tool_use/tool_result pair.
3. The snapshot then fed API rows to the same check. Those rows name the
   fields `message` and `file_pointer`, so the `artifactOnly` exemption (which
   reads `text`/`filePointer`) never matched. The checker reported the first
   artifact row after wait_for IN_PROGRESS as a model turn.

Replaying the captured frames and the snapshot from the run evidence: on
7eb275b1b the realtime path fails on 4011c420 and the snapshot fails on
wait_for. With the fix, the snapshot returns None.

A separate defect was observed in the same run. The root-level
spawn_claude_code_agent FINISHED row 75e5af12 (158,184 chars of text) was
committed, but its broadcast got HTTP 403 from Supabase's Cloudflare WAF ("Sorry,
you have been blocked", Ray a4f47669fe39d6d3). CommittedMessageDelivery logged
"exhausted attempts=1", so the realtime stream never closed that tool. That
defect is independent of this case and was handed to the parent as its own
cluster.

## Solution

`reconcile_snapshot` now normalizes `message`→`text` and
`file_pointer`→`filePointer`, so both paths apply the same contract. Display
rows that are excluded from the model and carry a file pointer are not treated
as assistant turns. An authored, model-visible assistant row still fails while
a tool is open; both regressions assert that negative case. This is
evaluator-only, with constant per-record work and no runtime effect at 10k
agents.

## Human feedback

None recorded.

## Reusable lesson

When an invariant checks both realtime records and API snapshots, normalize
both into one record shape before applying any exemption.
