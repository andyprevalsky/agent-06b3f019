---
id: 2026-11-04-code-agent-superseded-partial-snapshots-retained
date: 2026-11-04
title: Code-agent activity memory and durable transcript grew with the square of streamed output by keeping every cumulative partial snapshot
surface: agents
component: spawn-claude-code-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/service.py _run_agentic_loop on_event appended every partial agent_message/thinking event (each carrying the whole block so far) to code_events, and format_code_events_transcript wrote one line per partial snapshot
symptoms:
  - "retained 7380000 chars of text for a 120000-char answer"
  - durable code transcript repeats the same assistant message once per streamed delta
  - code-agent worker memory grows quadratically with streamed output
  - persist_terminal_output POST of a multi-megabyte transcript
tags:
  - memory
  - partial-messages
  - transcript
  - quadratic-growth
  - code-agent
  - multi-day
sources:
  - commit 28a7bfc99 (base on which the repro fails; fix on branch fix/code-agent-multiday-t1-ws-transport)
  - task T1 of the parent RCA "Review long-running rose code agents" (devbox 211c7467), findings T1 #4 and #5
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_run_agentic_loop_retains_linear_text_for_streamed_answer (+ test_durable_transcript_writes_each_streamed_message_once, test_transcript_revision_keeps_rising_across_a_compacted_replay, test_empty_final_thinking_keeps_the_streamed_thinking_text)
status: fixed
---

## Problem

Streaming one 120 kB answer as 120 deltas left the activity holding 7,380,000
characters of text in `code_events` (`retained 7380000 chars of text for a
120000-char answer`) on a shared 2 GB worker, and
`build_durable_terminal_transcript` wrote 121 `[Claude]` lines for that one
message (base 28a7bfc99). Over hours of output both grow with the square of
message length, and the end-of-run `persist_terminal_output` POST carries it.

## Diagnosis

The ws-servers emit `--include-partial-messages` deltas as upserts: each partial
event's `text` is the whole block so far, keyed by `item_id`; the final block
reuses that `item_id`. `_latest_stream_snapshots` already applied that
upsert rule for judge evidence, but `on_event` kept every snapshot and
`format_code_events_transcript` rendered each one. The data model (upsert by
item) was applied in one consumer and not in storage or the transcript.

## Solution

`_supersede_partial_snapshot` drops the cumulative `text` of an item's previous
partial snapshot as soon as a newer snapshot or the final block arrives (the
stored copy keeps its delta and index, so event indices still identify sandbox
events across replays); both ws-servers apply the same rule to their replay
buffer. An empty final (redacted thinking) supersedes nothing, so streamed thinking
text stays in the event buffer, replay and judge evidence (the transcript
record still follows the final block and shows it redacted), and the key includes `turn_id` so a Codex item id reused in
a later turn cannot empty an earlier turn's text. Because a replayed superseded
partial now carries no text, `utils/code_transcript.py` still counts it as a
revision of its item (keeping the stored text); otherwise a reattach replayed
the final answer at a lower `rev` than the partial already persisted and
readers that keep the highest rev showed the truncated partial forever (found
by adversarial review; regression
`test_transcript_revision_keeps_rising_across_a_compacted_replay`).
`format_code_events_transcript` renders `_latest_stream_snapshots`, so
each message is one line. Retained text is now at most twice the output.
`persist_terminal_output` still swallows a failed POST; the incremental
transcript batches remain the durable record, and its size is now linear
(not changed here: error/retry paths belong to cluster T5).

10k-agent behavior: per-session memory linear in that session's output, no
shared state; transcript POST bodies shrink by the same factor.

Pending: on the branch; the parent integrates it into the combined deploy.

## Human feedback

None recorded.

## Reusable lesson

When a stream emits cumulative upserts keyed by an item id, keep only the latest snapshot per item in every store and renderer, not just in one consumer.
