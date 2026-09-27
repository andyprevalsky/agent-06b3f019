---
id: 2026-09-18-liveness-reconciler-skipped-chat-mode-escalation
date: 2026-09-18
title: Liveness reconciler skipped hung chat escalations because it required a Temporal workflow id
surface: cross
component: workflow-liveness-reconciler
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/workflowLivenessReconciler.ts findLivenessCandidates — candidate query required temporalWorkflowId not null, so ACTIVE chat-mode rows that never started a workflow were invisible to the only repair job
symptoms:
  - agent not loading
  - ACTIVE temporal_workflow_id null message_count 0
  - "[ChatHandler] Escalating to superintelligence"
  - permanent Thinking shimmer in chat mode
  - "Chat escalation never started a workflow. Sealed by liveness reconciler."
tags:
  - chat-escalation
  - agent-lifecycle
  - reconciliation
  - zombie-agent
  - thinking-visibility
sources:
  - agent a7463bcc-d168-47e0-b606-5b3ea31e1be0
repro: back-end/src/tests/blackbox/agents-liveness-reconcile.cases.ts "reconciler seals a quiet chat-mode agent whose escalation never started a workflow"; front-end/src/tests/blackbox/message-list-thinking-visibility.blackbox.tsx "does not treat a hung chat escalation as still thinking"; back-end/src/tests/unit/chat-escalation-deadline.test.ts
status: fixed
---

## Problem

Production agent `a7463bcc-d168-47e0-b606-5b3ea31e1be0` (Tamara Chayo, MAC_APP,
goal comparing medical tests Polanco vs home) never loaded. POST /api/agents
returned 201 at 20:57:25.369. The router chose `start_superintelligence` at
20:57:26.252 and the handler logged `Escalating to superintelligence`. Then
silence. The durable row stayed `ACTIVE`, `temporal_workflow_id` null,
`message_count` 0. Messages were USER + ASSISTANT router reasoning only — no
Cloud Agent TOOL chip, no Temporal workflow. The client polled GET ~2s and
`useThinkingVisibility.computeShouldShow` returned true, so the UI showed
Thinking forever.

This is a relative of
`2026-08-04-no-liveness-reconciler-for-externally-closed-workflows`. That job
repairs workflow-backed zombies. It never selected chat-mode rows.

Archive searches: `not loading ACTIVE temporal_workflow_id null Thinking`,
`chat escalation never started workflow stuck shimmer`,
`Thinking forever messageCount 0 ACTIVE no workflow`. Closest hit is the
2026-08-04 case. Relatives: `2026-08-21-chat-escalation-overwrites-workflow-generation`,
`2026-07-16-chat-pinned-to-cerebras-with-same-provider-failover`. Novel as a
chat-escalation hang with no workflow id.

## Diagnosis

Critical path: MAC_APP create → fire-and-forget `handleChatMessage` → router
`start_superintelligence` → persist ASSISTANT → persist Cloud Agent TOOL →
`startTemporalWorkflowForChat` → Temporal accept → FE `computeShouldShow`.

Binary search:

1. Create succeeded (201, row exists).
2. Router ran (ASSISTANT reasoning persisted, "Escalating" log).
3. Cloud Agent TOOL never persisted and `temporalWorkflowId` stayed null —
   first durable miss is the unbounded persist/start after the router decision.
4. `handleChatMessage` is fire-and-forget. The create catch
   (`failAgentIfStillActive`) only runs if the promise rejects. A hung
   `createMessage` never rejects, so the agent stays ACTIVE.
5. `findLivenessCandidates` requires `temporalWorkflowId: { not: null }`. The
   only repair job cannot see this row.
6. FE treat live-ness as a deny-list of terminal statuses. ACTIVE + last
   ASSISTANT + chat mode + no stream ⇒ Thinking.

Deepest owned cause: a lifecycle with no observer. Chat escalation has no
deadline and no liveness selector for ACTIVE + null workflow + messageCount 0.
The 2026-08-04 guardrail failed to hold because its candidate query assumed a
workflow id — the reporter of death was still "the process itself", and chat
mode has no process.

Pre-fix local repro (identical commands):

- `npx tsx /tmp/run-stuck-chat-liveness.ts` →
  `stuck chat escalation must be sealed FAILED, got ACTIVE` (95ms)
- `npx vitest run src/tests/blackbox/message-list-thinking-visibility.blackbox.tsx`
  → expected document not to contain Thinking, found the shimmer span (1122ms)
- `npx tsx src/tests/unit/chat-escalation-deadline.test.ts` →
  `withChatEscalationDeadline is not a function`

## Solution

Three layers, same class (unbounded chat work with no observer):

1. `findStuckChatCandidates` + `sealStuckChatAgent` in
   `workflowLivenessReconciler.ts`. Quiet ACTIVE + null workflow +
   messageCount 0 seals to FAILED with
   `STUCK_CHAT_STATUS_MESSAGE`. Finished chat turns write messageCount > 0 and
   are left alone. Conditional `updateMany` so a late Temporal accept wins.
2. `withChatEscalationDeadline` around the two persist writes so a hung
   `createMessage` rejects and `failAgentIfStillActive` can fire without
   waiting for the 5-minute quiet window. Temporal start stays outside — it
   already has accept/terminate.
3. `computeShouldShow` hides Thinking when chat mode's last durable row is
   ASSISTANT and nothing is streaming, so a hung escalation does not shimmer.

Cemented in the three repros above. Post-fix the identical commands pass
(liveness 256ms seal + completed-chat control; FE 2/2; deadline PASS).

10k agents: one extra bounded `findMany` per tick (`take: batchSize`), no
Temporal describe, no per-user fan-in, no shared mutable state. Work scales
with quiet stuck-chat candidates per tick, never with total agent count.

Sibling failures prevented: any fire-and-forget chat path that dies after the
router decision and before Temporal accept (hung Prisma, hung persist, process
death mid-escalation).

## Human feedback

None recorded.

## Reusable lesson

A liveness job that requires a workflow id cannot repair the hang that
prevented the workflow from existing — select the pre-workflow shape too,
and bound the fire-and-forget persist that creates it.
