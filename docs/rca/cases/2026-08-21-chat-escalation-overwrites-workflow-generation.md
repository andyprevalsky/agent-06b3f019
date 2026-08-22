---
id: 2026-08-21-chat-escalation-overwrites-workflow-generation
date: 2026-08-21
title: Delayed chat escalation overwrote the workflow generation selected by deployment cutover
surface: back-end
component: chat-workflow-escalation
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/chat/chatHandler.ts startTemporalWorkflowForChat unconditionally updated Agent.temporalWorkflowId after its asynchronous Temporal start
symptoms:
  - "POST /:id/messages — deployment fence preserves success and blocks stale writes"
  - "a first stale write after cutover must become the canonical deployment error"
  - "new code version deployed, retry this tool"
tags:
  - workflow-generation
  - deployment-cutover
  - chat-escalation
  - compare-and-swap
  - concurrency
sources:
  - commit a221a3eae
repro: back-end/src/tests/blackbox/agents-messages.cases.ts under npm run test:coverage, with isolated lock ordering in back-end/src/tests/unit/workflow-generation-locks.test.ts
status: fixed
---

## Problem

The canonical backend coverage command passed 129 of 130 blackbox domains but
the agents domain failed its deployment-fence case. The first stale tool call
after cutover persisted the incoming text `Started after cutover` instead of the
canonical deployment error. The exact pre-fix command
`cd back-end && npm run test:coverage` exited 1 and reported
`FAIL POST /:id/messages — deployment fence preserves success and blocks stale writes`.
A serial agents-domain rerun passed 180 of 180 cases, confirming that the
failure required the loaded asynchronous ordering from the coverage gate rather
than a deterministic lifecycle-message transformation error.

## Diagnosis

The critical path was chat-mode agent creation, fire-and-forget chat routing,
chat escalation to Temporal, the test's workflow-generation cutover, internal
`POST /api/agents/:id/messages`, lifecycle generation validation, and Message
persistence.

The failed agent's durable rows reconstructed the ordering. Its old-generation
progress and successes were written from `01:06:27.623` through
`01:06:27.802`. The cutover Agent update completed at `01:06:27.834`. The
background chat handler then persisted `Creating Cloud Agent` at
`01:06:27.931`. The supposedly stale call persisted unchanged at
`01:06:27.993`, while the replacement-generation call was incorrectly converted
to `DEPLOY_INTERRUPTED` at `01:06:28.035`. The Agent's workflow ID had returned
to the old agent ID.

`startTemporalWorkflowForChat` started Temporal and then performed an
unconditional `prisma.agent.update({ temporalWorkflowId: workflowId })`.
Because chat handling is deliberately fire-and-forget, that ownership write
could complete after deployment had already selected a replacement generation.
The message lifecycle code then correctly trusted the now-corrupted Agent row.
The deepest owned cause was an asynchronous ownership transition without the
workflow-generation lock, a compare-and-swap, or exact-execution compensation.
The sibling error path could also mark a replacement generation FAILED because
its status update was not generation-scoped.

Archive searches for `a first stale write after cutover canonical deployment
error` and `delayed chat escalation workflow generation overwritten
concurrency` found the 2026-08-03 gate transaction fan-in case and the
2026-08-03 competing-chat test-fixture case. They were relatives, not
recurrences: this incident's first bad data was a production ownership write,
not transaction expiry or a route whose fixture had already reached its
expected terminal state.

## Solution

Chat escalation now retains Temporal's immutable workflow and first-execution
IDs, then accepts them inside the per-agent workflow-generation lock only when
the Agent remains ACTIVE, undeleted, and in chat mode or already owns the exact
same execution. A cutover or another generation that wins first remains
authoritative, and the exact stale Temporal chain is terminated instead of
being orphaned. Chat startup failures are likewise scoped to a null or matching
generation, so delayed error handling cannot fail a replacement.

The concurrent lock-order unit regression holds cutover's exclusive generation
lock, proves chat acceptance waits, and verifies that the replacement ID and
empty first-execution ID survive. The original blackbox assertion is unchanged.
The post-fix `cd back-end && npm run test:coverage` command exited 0: all 155
unit files and all 130 blackbox domains passed, including the unchanged
deployment-fence assertion, with coverage above every configured threshold.

At 10,000 agents this adds one lock/read/update transaction only when chat
actually escalates. The lock is keyed per agent; there is no global queue,
table scan, cross-agent fan-in, or unbounded polling.

## Human feedback

The user required the canonical local failure/pass proof and explicitly
prohibited weakening the deployment-error assertion.

## Reusable lesson

Commit asynchronous workflow ownership under the per-agent generation lock with
compare-and-swap semantics, and compensate the exact losing external execution.
