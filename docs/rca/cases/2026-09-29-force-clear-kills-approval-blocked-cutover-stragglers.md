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
   FAILED and sealed the workflow id (first-bad boundary).
4. Late `reply_to_agent` could not recover: `claimReplacementGeneration` skipped
   `status===FAILED` when a snapshot `deploymentAttempt` was present, and the
   user-initiated path still inherited that skip for FAILED cutover rows.
   The sealed id made the Temporal signal a no-op.

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
generation (`clearSupersededGenerationWorkflow` → `restartAgent`), the same
path as `POST /restart`. Orphan Temporal executions with no Agent row are still
terminated.

Sibling recoveries for agents already killed by the old force-clear:

- user-initiated `claimReplacementGeneration` (no `deploymentAttempt`) no
  longer skips FAILED cutover rows; snapshot/deploy claims still do
- `commitReplyToAgent` skips signaling `:deployment-sealed:` ids and restarts
  when the agent is cutover-FAILED or the attention row is
  `DEPLOY_INTERRUPTED`
- SMS supervisor hierarchy keeps `FAILED` + `Generation cutover:` roots visible
  so a late approve has a target

10k-agent behavior: force-clear iterates only workflows still Running on the
superseded queue after the 45m drain (bounded stragglers, not live fleet size).
Each owned id is one restart. SMS recovery is one agent per inbound reply. No
shared fan-in, no per-user firehose.

## Human feedback

None recorded.

## Reusable lesson

A workflow still on the old generation queue after the drain SLO is parked, not
dead — replace it onto the live generation; never mark an approval-blocked
agent FAILED.
