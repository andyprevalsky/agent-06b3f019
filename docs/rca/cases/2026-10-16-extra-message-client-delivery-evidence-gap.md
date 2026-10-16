---
id: 2026-10-16-extra-message-client-delivery-evidence-gap
date: 2026-10-16
title: Canonical answer history did not supersede its live attention projection
surface: front-end
component: message-list-stream-reconciliation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: useFilteredStreaming returned streamingAttention even when persistedMessages already contained the same send_message_to_user toolCallId
symptoms:
  - "weird fe state"
  - "extrra message rendering"
  - "same answer twice"
  - "expected ... to have a length of 1 but got 2"
tags:
  - chat
  - realtime
  - duplicate-message
  - attention-stream
sources:
  - agent 0a3ec6f7-a8ce-4996-bf98-7ef8f3af82c7
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
repro: front-end/src/tests/blackbox/streaming-attention.blackbox.tsx
status: fixed
---

## Problem

The user saw the same answer twice in the agent chat. The original report said
`weird fe state` and `extrra message rendering`; the user subsequently confirmed
`same answer twice` and instructed the agent to fix the reproduced issue.

The production agent-detail GET returned 32 rows: five USER, eight ASSISTANT,
and 19 TOOL rows. Fourteen TOOL rows are seven searches' start/result pairs;
five are canonical `send_message_to_user` replies. Every message ID is unique.
The final `hello` has one reasoning row `304c335e-6ecd-48f8-a5d2-2c2c22e0f842`
at 20:07:34.569Z and one reply `fe1c5876-5d62-4405-8ee4-3e9a393a0747` at
20:07:34.612Z, with toolCallId `5acf7661-9775-4006-93da-807dce4b3fa4`.
The saved conversation itself has no duplicate reply.

Private original evidence is retained in this workspace under
`.context/rca-0a3ec6f7-a8ce-4996-bf98-7ef8f3af82c7/`: `agent-response.json`,
`agent-logs.txt`, `backend-realtime-logs.txt`, `render-all.json`, and
`render-agent.json`. The Render window 20:06:00–20:07:45 UTC was paginated to
completion: 9,742 service rows, 780 mentioning this agent. Eight records at
20:06:15.870Z report `Initial broadcast delivery rejected`, `reason: capacity`,
for this agent's topic. These establish broadcaster admission rejections;
they do not identify event types, subsequent delivery, or client receipt.
No causal claim about those eight rejections is needed for the rendering fix.

## Diagnosis

The path is chat Generator → per-agent attention broadcasts and persisted
Message rows → realtime INSERT or agent-detail snapshot → AgentContext →
useFilteredStreaming → MessageList's canonical and live answer renderers.

**What:** the live projection and canonical message can both render one logical
answer. **Where:** `useFilteredStreaming` applied only sub-agent ownership to
attention, without checking canonical answer membership. **Why:**
`handleInsertMessage` cleared matching attention when the INSERT arrived, but
`applyAgentBackfill` adds the same canonical row without that side effect. A
later nonempty attention frame can also recreate attention after its canonical
INSERT cleared it. The renderer accepted both sources independently.
**Proof:** the permanent MessageList blackbox below renders the captured reply
twice under each schedule. **Problem:** canonical/live projection reconciliation
was dependent on the transport and event order instead of logical answer ID.

The next owned cause is the missing canonical-supersedes-live invariant at the
shared derivation used by every message arrival path. Ordinary streaming tools
already coalesce against persisted toolCallIds there, but attention did not.
The repair belongs in this derivation rather than adding another reconciliation
side effect to every INSERT, snapshot, and late-frame handler. Beyond this rung,
lossy/out-of-order transport is an intentional constraint, not a reason to
serialize per-agent streams or add retries to the UI.

The permanent regression uses the captured final answer's text and IDs and
executes the actual MessageList, applyAgentBackfill, and realtime handlers.
Its three failing schedules are (1) stream followed by canonical snapshot,
(2) canonical snapshot followed by late stream, and (3) canonical INSERT
followed by late stream. It also keeps an unrelated active tool visible and
preserves a new reply with identical text but a different toolCallId.

Exact command, from `front-end/`, on both buggy and fixed code:

```sh
npm run test -- --maxWorkers=1 src/tests/blackbox/streaming-attention.blackbox.tsx
```

Before: exit 1, three failed and three passed, 6.83 seconds; each failing DOM
assertion expected one copy and received two. After: exit 0, six passed,
7.46 seconds, with the same assertions. Evidence is `permanent-before.log`
and `permanent-after.log` in the private directory above. The earlier candidate
replay and logs are retained too. Original Mac delivery order was not captured;
these controlled schedules prove the shared rendering defect rather than
claiming to identify which historical schedule occurred.

Archive searches: `send_message_to_user streamId duplicate message`,
`extra message rendering thoughts chat frontend`,
`ATTENTION_STREAM snapshot duplicate`, and
`canonical attention streaming backfill`. The April 13
`realtime-insert-not-deduped-by-message-id` case and July 21
`one-shot-snapshot-succeeds-then-misses-final-insert` case are relatives.
The former's message-ID guard is present; this defect concerns two distinct
projections of one tool call and is not a proven recurrence of either case.

## Solution

`coalesceStreamingAttention` derives attention visibility from authoritative
persisted `send_message_to_user` toolCallId membership. Once the saved answer
exists, its live projection is hidden regardless of whether history arrived
through INSERT or snapshot, or a stream frame arrived late. This removes the
renderer’s dependence on handler ordering without adding state, timers, retries,
or a completed-ID cache. A new logical reply remains visible even when its
text matches an earlier answer.

The permanent regression is in the frontend Vitest blackbox suite, discovered
by `front-end/vitest.config.ts` and run under `/deploy` Step 4b's complete
frontend coverage/blackbox command. No runner or deploy-gate changes are needed.
Independent adversarial code/RCA review passed, including 33 tests across the
streaming-attention, realtime-handler, and INSERT-delivery suites. The touched
hook also moves its explore-task ID derivation inside the existing memo to
resolve its missing-dependency lint warning. Deployment and broader verification
are tracked by the normal deploy lifecycle.

At 10k agents this adds one linear membership check over only the selected
agent's existing transcript inside the memoized render derivation. It opens no
channels, schedules no polling, queries no rows, sends no broadcasts, and adds
no shared state or contention. The attention state remains a single bounded
projection; a later answer replaces it normally.

Golden references inspected: Claude
`claude-code-src/src/hooks/useRemoteSession.ts:280` clears partial tool state on
complete message; OpenClaw
`openclaw/ui/src/pages/chat/terminal-message-identity.ts:94` removes a live
terminal projection when authoritative history contains its ID; Hermes
`hermes-agent/apps/desktop/src/lib/chat-messages/reconciliation.ts:22` matches
local/hydrated assistants by message or tool ID; Codex
`codex/codex-rs/tui/src/chatwidget/streaming.rs:415` records completed turn/item
identity and finalizes the active stream. The repair converges on their shared
canonical-completion supersession pattern.

## Human feedback

The initial investigation left the report open pending whether the extra row
was a Thought card or a duplicate answer. The user clarified: `same answer
twice, if u had the repro fix that issue`. Once a concrete duplication mechanism
has been reproduced, fix it instead of deferring for a historical client trace
that is unnecessary to repair the demonstrated rendering invariant.

## Reusable lesson

Derive live-answer visibility from canonical tool-call identity so snapshots and late stream frames cannot render a second copy of a saved reply.
