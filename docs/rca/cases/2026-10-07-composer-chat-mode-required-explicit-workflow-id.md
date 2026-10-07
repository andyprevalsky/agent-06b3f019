---
id: 2026-10-07-composer-chat-mode-required-explicit-workflow-id
date: 2026-10-07
title: Composer stayed on Stop after COMPLETED because chat mode required an explicit temporalWorkflowId field
surface: cross
component: fe-chat-mode
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/agent-context/hooks/useRealtimeSubscription.ts — a finished root completion_summary never restored isChatMode, so a connected session that did not apply COMPLETED stayed ACTIVE + sticky-false and rendered Stop
symptoms:
  - The fe can’t send messages??
  - isChatMode stayed false after AGENT_MODE_STARTED
  - UPDATE status COMPLETED without temporalWorkflowId
  - canSubmit false Stop button after COMPLETED
  - completion_summary FINISHED isFinalSummary true
tags:
  - composer
  - chat-mode
  - realtime
  - temporal-workflow-id
  - completion-summary
  - post-completion
sources:
  - agent 3be856d5-e4fe-4eb5-b30e-ea99d44793fe
repro: front-end/src/tests/blackbox/hooks-lib-realtime-handlers.blackbox.ts
status: fixed
---

## Problem

Production Mac-app agent `3be856d5-e4fe-4eb5-b30e-ea99d44793fe` (Embarcadero
gaming-cafe goal) escalated via `cloud_agent` at 16:37 and published a root
`completion_summary` FINISHED `isFinalSummary: true` at 16:40:53. Later GET
showed `ACTIVE` with `temporal_workflow_id: None`. USER follow-ups at 17:41–17:44
persisted, so `POST /api/agents/:id/messages` worked (Enter still calls
`onSubmit` while the button is Stop). `composerCanSubmit` is false for a selected
ACTIVE row when `isChatMode` is false. After `AGENT_MODE_STARTED` / `cloud_agent`
IN_PROGRESS, that flag is sticky-false until something restores it.

## Diagnosis

Archive searches for "fe can't send messages composer Stop isChatMode COMPLETED
temporalWorkflowId" and "chat mode restore completion_summary AGENT_MODE_STARTED"
found relatives (leftover workflow id on follow-up, composer write-lock, SMS
resume split-contract) but not this sticky-flag class. Novel.

`clearWorkflowForTerminalAgent` writes ACTIVE + a null workflow id in Postgres
and does not broadcast. A later GET of ACTIVE + `None` is a DB snapshot, not an
FE UPDATE. `canSubmit` is already true while FE status is COMPLETED, even if
`isChatMode` is still false. A remount/backfill after the follow-up would have
restored chat via `!temporal_workflow_id`.

The Stop button on this long-lived Mac session therefore requires FE status to
still be ACTIVE with sticky `isChatMode=false`. That happens when the COMPLETED
UPDATE is not applied (missed broadcast or the client never merged it) and
nothing else clears the latch. Prod `broadcastStatus` also omitted
`temporalWorkflowId`, so `handleUpdateAgent` would not restore chat from the
field-presence path even when COMPLETED did arrive. Terminal rows can keep a
leftover DB workflow id until the first follow-up, so a fetch that only keyed on
`!temporal_workflow_id` could also stay false.

The run-ended signal the transcript always has is the root `completion_summary`.
Old `useRealtimeSubscription` never restored chat from that INSERT. That is the
first-bad boundary for a connected session that stays ACTIVE.

Classification: our-bug. Problem class: two sources of truth for "can the user
type" (`isChatMode` vs actual run state). Not model-intelligence.

Golden reference: Claude Code `PromptInput.tsx:302` keeps the prompt writable
and queues while live `isLoading` is true (`useCommandQueue`). It does not own a
sticky chat-mode bit that can desync from run state. `openclaw/`, `hermes-agent/`,
and `codex/` were not present in this checkout; this composer Send/Stop toggle
is product-specific. The fix converges on deriving send-capability from terminal
/ no-workflow / finished-summary state rather than a one-way sticky flag.

## Solution

Restore chat mode when a root `completion_summary` finishes, when an UPDATE is
terminal or carries an explicit null workflow id, and when a detail
fetch/backfill shows a terminal agent or no live workflow. Status broadcasts now
publish `temporalWorkflowId: null` on terminal statuses so the old
field-presence path also recovers.

Siblings this also prevents: FAILED / OUT_OF_CREDITS / COST_LIMIT_REACHED
composers stuck on Stop; leftover workflow id on a COMPLETED snapshot; a later
ACTIVE overwrite after COMPLETED arrived without restoring the flag.

At 10k agents this is still one boolean write per already-authorized per-agent
UPDATE/INSERT/fetch. No shared topic, no extra poll, no fan-in.

Owning regressions:
- `front-end/src/tests/blackbox/hooks-lib-realtime-handlers.blackbox.ts`
- `front-end/src/tests/blackbox/hooks-lib-realtime-subscription.blackbox.ts`
- `back-end/src/tests/unit/status-broadcast-workflow-id.test.ts`

Pre-fix the handler/subscription cases failed (`isChatMode` stayed `false`).
Post-fix the same files pass (44 tests).

## Human feedback

None recorded.

## Reusable lesson

Never gate the composer on a sticky client flag that only clears when an optional realtime field is present; restore send-capability from the run-ended signals the client already receives (terminal status, finished root completion_summary, or an explicit null workflow id).
