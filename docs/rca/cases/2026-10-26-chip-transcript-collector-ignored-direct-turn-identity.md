---
id: 2026-10-26-chip-transcript-collector-ignored-direct-turn-identity
date: 2026-10-26
title: Code-agent chip transcript showed a direct turn twice because its event collector ignored the turn id
surface: front-end
component: code-agent-chip-transcript
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/hooks/codeSessionTranscript.ts collectCodeAgentEvents emitted both the user_direct_turn row and the session's own user record with the same client_message_id
symptoms:
  - "You → Codex: hurry up" shown twice in a row in the code-agent chip transcript
  - sending codex a msg gets double posted
  - direct turn duplicated in the Transcript of a live Codex / Claude Code chip
tags:
  - code-agent
  - codex
  - direct-turn
  - transcript
  - dedupe
  - rose-desktop
sources:
  - agent d324c2f0-22bd-49ca-a881-c2baddc807fa (code session b5087a61-dc31-498c-b82c-e32b918c8590)
  - commit 86dbf8b02 (branch fix/ui26-coding-agent)
repro: front-end/src/tests/blackbox/code-agent-steering.blackbox.tsx "a direct turn the session echoed back (same client_message_id) renders once"
status: fixed
---

## Problem

Andy's screenshot of a live Codex chip showed "You → Codex: hurry up" twice in a
row. Read-only prod query (BEGIN READ ONLY) on the code session found exactly one
backend `user_direct_turn` row (a0774b70…, `direct_turn_id` turn-8ec39fb3…, 16:10:20.725Z)
and exactly one session transcript record (`code_transcript` row 5b755465…, seq 117,
`client_message_id` turn-8ec39fb3…, 16:10:20.673Z). The Codex SDK event blob
contains one `user_turn` (seq 118) for that text: delivered and persisted once.

## Diagnosis

Path: POST /claude-code-session/:taskId/turns → backend persists
`user_direct_turn` row + Codex echoes the turn as a transcript record → both rows
reach the owner's messages → `useDesktopCodeAgent` → `collectCodeAgentEvents` →
`CodeAgentTranscript` rows. The data is correct up to the messages array (two
rows by design: acknowledgement + session record). `collectCodeAgentEvents`
turned each into its own user event, with no identity reconciliation, so the
chip rendered two `YouRow`s. The code-agent view's builder
(`codeSessionTurns.buildTimeline`) already merges the same pair by
`turn:<client_message_id>`; the chip's collector was a second projection of the
same contract that never received that rule.

## Solution

`collectCodeAgentEvents` drops a `user_direct_turn` row whose `direct_turn_id`
matches a session user record's `client_message_id` (text match only for rows
without an id, mirroring `buildTimeline`). Only records the collector actually
emits (timestamped, sender user) count, so a turn is never hidden entirely, and
two separate sends of the same text still render twice. Cost is O(rows of this
task) per memoized recompute, unchanged at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

When two projections render the same canonical record, reconcile them by the record's identity in every projection, not just the one that was tested.
