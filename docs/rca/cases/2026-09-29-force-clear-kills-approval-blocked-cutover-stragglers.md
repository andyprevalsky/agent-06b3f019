---
id: 2026-09-29-force-clear-kills-approval-blocked-cutover-stragglers
date: 2026-09-29
title: Force-clear after the 45m cooperative drain SLO marked approval-blocked agents FAILED instead of replacing them onto the live generation
surface: back-end
component: generation-queue-cutover
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/force-clear-generation-queue.ts — owned workflows still on the superseded queue were terminated and written Agent.status=FAILED with a :deployment-sealed: temporalWorkflowId
symptoms:
  - 'Generation cutover: terminated workflow still on superseded queue'
  - ':deployment-sealed:'
  - 'new code version deployed, retry this tool'
  - late SMS approve of a browser request_user_approval leaves the agent FAILED
  - Agent.status=FAILED after deploy while an attention request is still outstanding
tags:
  - generation-cutover
  - force-clear
  - request-user-approval
  - deployment-sealed
  - sms-supervisor
sources:
  - agent 3eb6da5a-280a-4456-a410-6b1799b06349
repro: back-end/src/tests/unit/generation-queue-cutover.test.ts
status: fixed
---

## Problem

Prod agent `3eb6da5a-280a-4456-a410-6b1799b06349` (SMS-started Amazon Glide
floss purchase) created browser write-lock attention request
`cmum2ov4q09hc8nvrgnh6ckyl` at `2026-09-29T02:44:20Z` and parked the Temporal
workflow on `_signal_responses`. At `03:34:46Z` the cooperative-cutover 45m
SLO invoked `force-clear-generation-queue.ts`, which terminated the still-running
workflow and wrote:

- `Agent.status = FAILED`
- `statusMessage = Generation cutover: terminated workflow still on superseded queue navi-agent-tasks@…`
- `temporalWorkflowId = 3eb6da5a-…:deployment-sealed:1140a40c-…`
- attention `userResponse = new code version deployed, retry this tool`

At `13:00:02Z` the user texted `approve`. SMS supervisor `reply_to_agent`
posted the USER row, failed to signal the sealed workflow (404 / not found),
and left the agent `FAILED`. The purchase stayed dead.

Archive searches: `Generation cutover terminated workflow superseded queue`,
`deployment-sealed late approve`, `request_user_approval deploy FAILED`,
`force-clear-generation-queue`. Relatives (not the same first-bad boundary):
`2026-08-19-deploy-fence-correlates-attention-requests-through-tool-metadata`,
`2026-08-21-descendant-tool-writes-default-to-generation-one`,
`2026-08-04-scheduled-wait-for-not-preserved-across-deploy-workflow-replacement`.
Novel cause: force-clear treated an in-tool wait as a dead straggler.

## Diagnosis

Critical path: browser `request_user_approval` → Temporal wait on
`receive_user_response` → deploy cooperative drain (`continue_as_new` only at
safe checkpoints) → 45m SLO `force-clear-generation-queue.ts` →
`Agent.status=FAILED` + `:deployment-sealed:` + `DEPLOY_INTERRUPTED` fence →
hours later SMS `approve` → `commitReplyToAgent` signals a tombstone → agent
stays FAILED.

Binary search:

1. Approval chip and attention row existed (`02:44:20Z`); workflow was Running
   on the old generation queue.
2. Cooperative cutover cannot `continue_as_new` while an activity is parked on
   an in-tool wait — the workflow remaining after 45m is expected, not dead.
3. Force-clear was the first write that mutated user-visible agent state to
   FAILED and sealed the workflow id (first-bad boundary). That kill is the
   bug — not the later SMS approve.
4. After the kill, `reply_to_agent` could only signal a tombstone. That is a
   consequence, not a second root cause.

Local repro (identical command pre/post):

```
cd back-end && npx tsx src/tests/unit/generation-queue-cutover.test.ts
```

Pre-fix: `force-clear replaces an approval-blocked agent instead of marking it
FAILED` failed — the legacy path wrote `status: FAILED` and returned no
replacement id. Post-fix: all five cases pass, including the prod-shaped
FAILED+sealed SMS approve recovery.

## Solution

Owned stragglers on a superseded generation queue are replaced onto the live
generation (`clearSupersededGenerationWorkflow` → `restartAgent`). Force-clear
must not write `Agent.status=FAILED` for any AgentStatus. The agent stays
alive on the new generation; in-flight tools use the existing
`DEPLOY_INTERRUPTED` retry contract. Orphan Temporal executions with no Agent
row are still terminated.

In-tool parks now yield cooperatively so cutover does not wait for the SLO:

- Cooperative (30s poll → `GenerationHandoffRequested` → chip FINISHED with
  `DEPLOY_INTERRUPTED` → run_agent checkpoint 1.6 `continue_as_new`):
  approval, gate, signup, send_message, wait_for, wait_seconds, spawn
  child/slot/pause, browser auth + AgentCard funding/setup sleeps.
- Activity-bound (cannot `continue_as_new` while the activity handle is
  running; force-clear *replaces*): browser / claude-code / explore
  `activity_handle.done()` waits.
- Bounded 30s (`_wait_for_messages`): next loop iteration re-checks the
  pointer.
- Deploy-gate (`_deployment_validation`): isolated validation run, not a
  user agent.

Already-killed rows from the old force-clear can still be revived by
user-initiated `POST /restart` / `reply_to_agent` (claim no longer skips
FAILED when `deploymentAttempt` is absent). That is a backstop for the
already-dead prod agent, not the product fix.

10k-agent behavior: force-clear iterates only workflows still Running on the
superseded queue after the 45m drain (bounded stragglers, not live fleet size).
Each owned id is one restart. No shared fan-in, no per-user firehose.

## Human feedback

Rejected framing the fix as "keep cutover-FAILED agents in SMS supervisor
context so a late approve can recover them." The question is why force-clear
marked the parent FAILED at all — we should never kill parked approval-wait
agents this way. Replace onto the live generation; do not paper over the kill
with post-failure SMS visibility.

## Reusable lesson

Never mark an owned agent FAILED to drain a superseded generation queue —
replace it onto the live generation; a parked approval-wait is not a dead
straggler.
