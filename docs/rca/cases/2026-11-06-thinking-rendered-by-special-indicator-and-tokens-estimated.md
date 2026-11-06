---
id: 2026-11-06-thinking-rendered-by-special-indicator-and-tokens-estimated
date: 2026-11-06
title: Thinking bypassed the tool row (animated indicator, italic button) and its tokens/tok/s were estimated or computed across tool runs
surface: cross
component: trajectory-work-group
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end TrajectoryWorkGroup / CodeSessionMessages WorkSlot / codeAgentChip ThinkingRow rendered thinking through bespoke indicators, and no producer recorded a thought's generation (root ASSISTANT rows had no usage/timing; the code-session adapter divided consecutive usage samples)
symptoms:
  - Working ▾ orange blob Thinking 102.1s
  - Thinking · 0s >
  - thinking row shows ↓ 100 tokens for a 400-character thought
  - tok/s missing for the root agent
  - code-agent tok/s flips between ~135 and ~1 tok/s
tags:
  - rose-desktop
  - trajectory-work-group
  - thought
  - tokens-per-second
  - code-agent
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82 (prod "Rose Repo Status", user 1f85ff25, 2026-11-06)
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82 code task 6f8f8f4d-c670-4bc8-b5df-e2c785c4a908 (Claude Code)
  - commit c74ff29fc
  - commit f59db2fa5
repro: front-end/src/tests/blackbox/thinking-tool-row.blackbox.tsx; agents/tests/blackbox/run_agent.blackbox.py test_assistant_thought_records_measured_generation
status: fixed
---

## Problem

Andy (2026-11-06) reviewed the Rose-on-Rose code-agent run "Rose Repo Status"
and asked that thinking render as a normal tool row, with working tok/s, for
both the root agent and code agents. He saw a live "Working ▾ ● Thinking 102.1s"
blob (S4) and an italic outlined "Thinking · 0s >" button (S5) in the code-agent
view, and believed the root agent had the same blob.

Runtime evidence (prod, read-only transaction): the root has 8 ASSISTANT rows
whose metadata holds only `tool_calls` / `streamId`: no usage, no timing. The
per-call output tokens exist only in ToolUsage (execute_loop iteration 3:
597 tokens). The code task 6f8f8f4d's transcript: Rose's goal at 04:21:22.635,
`turn started` at 04:24:18.720, usage samples (turn-cumulative output tokens)
17@21.601, 376@24.184, 384@30.816, 1201@36.866, 1217@43.444, 1594@45.935,
2436@54.487. One thinking record (redacted, rev 1 at 31.234, final rev 3 at
31.713), tool results at 29.199, 41.631 and 45.981.

## Diagnosis

1. Root (confirmed, same blob): `TrajectoryWorkGroup` replaced the running
   header's icon + label with the `indicator` prop (`ThinkingIndicator`: the
   ThinkingAnimation blob, shimmer "Thinking", ↓ tokens) whenever the latest
   activity was live thinking. Its tokens were `charCount / 4`; a persisted
   thought showed `text.length / 4` (`PersistedThinking`). The thought tool row
   in the history used the blob (in progress) or a blank 16px box (finished).
   Repro: the live-thinking case renders `thinking-indicator` +
   `thinking-animation` in the header and "1,000 tokens" for 4,000 streamed
   characters; a 400-character thought reads "Thinking100 tokens".
2. Root tok/s: never computed. The persisted ASSISTANT row carried no recorded
   usage or timing, so any FE rate would have been an estimate.
3. Code agent S4: `CodeSessionMessages` WorkSlot showed its `ThinkingIndicator`
   while `!turn.activityType`. Rose's goal opens the slot (04:21:22) about three
   minutes before the CLI turn starts (04:24:18), so sandbox boot read as
   "Thinking 102.1s", with no tokens because no usage sample existed yet.
4. Code agent tok/s: `SessionBuilder.metrics` divided consecutive usage
   samples. Claude Code samples usage at each model call's `message_start` and
   `message_delta`, so consecutive windows alternate between generation
   (359 tok / 2.58 s = 139 tok/s) and tool runs (8 tok / 6.63 s = 1.2 tok/s).
   Nothing persisted on a row.
5. S5: `codeAgentChip.steer.tsx` `ThinkingRow` computed seconds as the next
   event's ts minus the folded final-rev ts (31.715 − 31.713 → "0s").

Deepest owned cause (Step 5a): thinking had no single row contract. Three
renderers each improvised a thinking display and none had a recorded generation
to show, so each estimated or mis-measured. Fixing one renderer would leave the
other two (and the root producer) wrong.

## Solution

One contract: a thought row carries `metadata.generation =
{output_tokens, started_at, ended_at}`, written by its producer and read by one
FE function (`thoughtGeneration`); tok/s = recorded tokens / recorded window.

- Root producer: `call_llm_structured_streaming` records the measured request →
  stream-end window in its usage (measured usage only). `run_agent` attaches
  `llm_generation_metadata(usage)` to the ASSISTANT row (never for estimated
  usage or Fast Mode replays). UI-only: a regression proves `build_llm_messages`,
  `convert_context_to_messages` and `build_planner_messages` are byte-identical
  with or without it.
- Code-agent producer (`codeSessionTurns` `metrics()`): the usage samples around
  a finished thinking record bracket the model call that produced it (a turn
  counter starts at 0 with the turn). A window a tool finished inside is
  rejected, so rates only cover generation windows. Prod: 817 tokens / 6.05 s =
  135.0 tok/s.
- Rendering: `TrajectoryWorkGroup` drops the `indicator` prop and the
  text-length estimate; thinking is a stock activity (lightbulb + label + batch
  clock), and a finished thought appends "duration · ↓ tokens · tok/s". The
  shared `ToolMessage` thought row uses the lightbulb icon and the same metric.
  The WorkSlot indicator and chip `ThinkingRow` are deleted by Lane B's
  code-agent view conversion (the code view renders through
  `TrajectoryWorkGroup`).
- 10k-agent behavior: no new channels, subscriptions, queries or broadcasts.
  One small JSON object on each persisted ASSISTANT row. `metrics()` walks back
  only over activities newer than the previous sample.

## Human feedback

Andy (2026-11-06): thinking must always be a normal tool row in the work
description for both the root agent and code agents. tok/s must work for both,
from real token counts, never estimated from text length. The orchestrator
added: record usage/timing as non-LLM-visible metadata, proven by a test, and
compute code-agent rates only over generation windows, never across tool runs.

## Reusable lesson

Give a recurring UI concept one row contract fed by recorded producer data; a
renderer that has to estimate or improvise a metric means the producer never
recorded it.
