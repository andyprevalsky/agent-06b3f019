---
id: 2026-11-06-code-agent-judge-evidence-counted-raw-stream-and-cut-tail
date: 2026-11-06
title: Code-agent judge evidence counted the raw streamed events, kept duplicate tool_use previews and cut long sessions to 200 events, so every process-* task failed process-native-trace
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py _persist_code_agent_judge_evidence set steps_taken from the raw code_events list while _build_code_event_context persisted _latest_stream_snapshots(code_events)[-200:], and _latest_stream_snapshots kept Claude's partial tool_use block starts (keyed by tool_use_id, no item_id)
symptoms:
  - "Declared evaluator process-native-trace failed: Process Bench: missing/truncated SDK evidence count"
  - "Process Bench: missing/truncated SDK evidence count"
  - "Process Bench: missing/duplicate native tool identity"
  - "Process Bench: missing native command start"
  - code_agent_sdk_events chip metadata.steps_taken=333 but only 84 code_agent_events
tags:
  - process-bench
  - judge-evidence
  - partial-messages
  - code-agent
  - evaluator-contract
  - descend
sources:
  - fleet run 20261106-125725-4136767 (descend-failed-neverrun-20261106 cluster H-18, campaign campaign-20261106-125707-4128298, source a17dbe5aec, jobs r001-j0009..j0018)
  - agent 4fc14e8a-2429-4e57-9d4a-c7410924aba0 (process-meeting-scheduling r001-j0015, code task f67005e9-7619-4652-928c-54fbcf01ab8f)
  - commit 83f3ae0e76 (evaluator count guard, 2026-10-21), cf7ada83b8 (partial streaming, 2026-10-21), f603c23f2e (snapshot collapse in judge evidence, 2026-10-24)
  - commit on branch rca/h-18-20261106 (this fix)
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_judge_evidence_of_streamed_claude_session_satisfies_native_process_trace (+ agents/benchmarks/process_bench_test.py::test_paged_sdk_evidence_must_tile_the_whole_session, test_actual_producer_truncation_cannot_hide_earlier_forbidden_action)
status: fixed
---

## Problem

Every process-* task in descend batch 2 (8 of 8 run records: candidate-hiring,
contract-renewal, customer-onboarding, expense-reimbursement, investor-outreach,
meeting-scheduling, purchase-approval, incident-recovery) ended COMPLETED but
FAILED `process-native-trace` with `missing/truncated SDK evidence count`.
For meeting-scheduling r001-j0015 the `code_agent_sdk_events` chip had
`steps_taken=333` and 84 events. The worker log recorded 333
`Received code-agent event` rows for that task: 255 `agent_message` against 6
persisted, every other type equal. The 249 dropped events were superseded
partial `agent_message` snapshots (seq gaps 26-35 ... 122-326 sit right before
the final block of the same `item_id`). Three chips (candidate-hiring 519/200,
investor-outreach 661/200, incident-recovery 580/200) were also cut by the
`[-200:]` tail; incident-recovery lost 12 `tool_use` and 6 `tool_result` events.

## Diagnosis

The evaluator guard (83f3ae0e76) requires `steps_taken == len(events)` so the
producer's 200-event tail cannot hide an earlier forbidden action. Partial
streaming (cf7ada83b8) landed on a parallel branch the same day, and
f603c23f2e then collapsed superseded snapshots in the persisted list while
`steps_taken` still counted the raw list. So every streamed session failed the
count. Offline replay of all 8 records with only the count corrected surfaced
the next contract break: `missing/duplicate native tool identity`. Claude emits
a partial `tool_use` block start (empty input, same `tool_use_id`, no
`item_id`) before the assistant envelope, and `_latest_stream_snapshots` keyed
supersession by `item_id` only. The deepest owned cause is that the judge
evidence serialized one upsert stream three inconsistent ways. Counts came from
raw events, compaction covered only item-keyed snapshots, and storage was a cut
tail. Next rung (why did no test catch it?): the producer/evaluator contract
test used hand-built events without the streamed codec shapes. Its sibling, the
durable transcript rendering `[Claude tool] Bash · {}` before every call,
comes from the same compaction gap.

## Solution

One evidence list: `_persist_code_agent_judge_evidence` compacts with
`_latest_stream_snapshots` (now keyed by `item_id`, else a `tool_use`'s
`tool_use_id`). It counts exactly that list in `steps_taken` and stores all of
it in rows of at most 200 events. Each row carries
`metadata.sdk_event_range=[start,end)`. `process_bench._sdk_streams`
assembles a session's rows and requires them to tile `[0, steps_taken)`
exactly. A missing, overlapping or mis-sized row still fails
`missing/truncated SDK evidence count`, and a single row without a range is
checked exactly as before. Offline replay of the archived chips through the
fixed rule flips meeting-scheduling and contract-renewal to PASS on
process-native-trace. The rest now reach agent-behavior checks (`not a direct
fixture action`, wrong inputs) or were cut at capture and cannot be recovered.
10k-agent behavior: per code session, ceil(events/200) child-scoped rows,
each bounded like the old single row. There is no fan-in and no LLM context.
The same collapse also dropped every Codex `command` start (`partial: true`, same `item_id` as its completion), so a Codex process session failed `missing native command start`. The judge evidence now collapses only snapshot types (`agent_message`, `thinking`, `tool_use`; `keep_lifecycle_starts=True`). The model-visible context (parent tool result, verifier) and the transcript still fold Codex item starts into their completions, as Codex rollouts do. Both now drop Claude's duplicate partial `tool_use`. A golden review of fc4b838488 found that an unpaged row could be completed by tagged pages. An unpaged row now has to satisfy `steps_taken == len(events)` as before, and one session cannot mix paged and unpaged rows. Open (rule 20): evidence pages carry no idempotency key, because the backend honours `idempotencyKey` only for direct-code-turn and transcript TOOL rows (messageIdempotency.ts hasIdempotentKind).

## Human feedback

The coordinator rejected a recount-only fix. Long sessions must persist complete
evidence, or truncation must stay detectable. Use a bounded paged pattern,
not an unbounded blob (rules 13 and 28).

## Reusable lesson

Derive an evidence count and its stored rows from the same compacted list, and page long evidence instead of cutting its head.
