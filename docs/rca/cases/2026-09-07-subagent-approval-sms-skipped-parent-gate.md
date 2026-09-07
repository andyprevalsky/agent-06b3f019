---
id: 2026-09-07-subagent-approval-sms-skipped-parent-gate
date: 2026-09-07
title: Sub-agent write_lock approval skipped SMS because parent_workflow_id gate
surface: agents
component: request-user-approval
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/request_user_approval/service.py request_user_approval_direct — parent_workflow_id is None guard before notify_sms_event_activity
symptoms:
  - I didn’t get a text from the sub agent who got an approval request
  - Approve a $28.51 purchase from Nopa Fish
  - Sub-agents are excluded (scale)
  - parent_workflow_id
  - Sent write_lock SMS notification
tags:
  - sms
  - write-lock
  - approval
  - sub-agent
  - payment
  - request-user-approval
sources:
  - agent ef7e8089-5b2d-4d38-b1a4-0b8ff7ce0fc6
  - agent cd03d03a-91f4-41a2-b53c-a708219b815a
  - commit 07417f41e
repro: agents/tests/blackbox/request_user_approval.blackbox.py::test_direct_subagent_fires_sms_notify (via python scripts/run_blackbox_tests.py request-user-approval)
status: fixed
---

## Problem

SMS-sourced root agent `ef7e8089-5b2d-4d38-b1a4-0b8ff7ce0fc6` (goal: order fish & chips
from Nopa Fish) spawned general-purpose sub-agent
`cd03d03a-91f4-41a2-b53c-a708219b815a`. The child browser path reached checkout and
posted `request_user_approval` for a $28.51 purchase (`attentionRequestId`
`cmtqlj5qe00jknol5s26gewcv`, message at 2026-09-07 02:03:04Z with
`isUserAttentionMessage: true`). The user saw the approval in the FE / mobile
inbox but received no SMS; they later rejected via the UI at 02:05:49Z.

## Diagnosis

Critical path: browser `request_payment_card` →
`request_user_approval_direct` → `notify_sms_event_activity` (`write_lock`) →
`/api/send-sms/notify` → `notifyWriteLock` → Surge SMS/MMS.

At the midpoint (approval message on the sub-agent), the attention chip and
payment metadata were correct. The missing sink was outbound SMS.

`request_user_approval_direct` only called `notify_sms_event_activity` when
`parent_workflow_id is None`. Sub-agents always have `parent_workflow_id` set
(`spawn_sub_agents`), so the notify activity never ran. Commit `07417f41e`
widened write_lock SMS to every *root* source but kept the sub-agent exclusion,
reusing the `agent_started` 10k-agent firehose rationale. That rationale does
not apply to blocking approvals (O(approvals), not O(spawns)). The same guard
also suppressed setup handoff SMS in `request_user_attention_direct`.

Archive searches (`approval request text SMS sub agent`,
`notifyWriteLock subagent parent source SMS`,
`Sub-agents are excluded parent_workflow_id write_lock SMS`) found relatives
(SMS approval formatting, write-lock body) but no prior case on this gate —
novel mis-application of the root-only lifecycle rule to blocking approvals.
`test_direct_subagent_does_not_fire_sms_notify` had cemented the wrong contract.

## Solution

Always fire write_lock / attention SMS from `request_user_approval_direct` and
`request_user_attention_direct` for any agent that creates the request. Keep
`agent_started` root-only. Benchmarks remain suppressed centrally via
`Agent.isBenchmark` in the send-sms dispatcher.

Blackbox: replace `direct_subagent_no_notify` with `direct_subagent_notify` and
add `direct_subagent_attention_sms`. Pre-fix fail / post-fix pass recorded under
`/opt/cursor/artifacts/subagent_approval_sms_*.txt`.

10k-agent behavior: SMS count scales with blocking approvals/handoffs, not with
spawn count; no shared fan-in beyond the existing per-notify Surge send.

## Human feedback

None recorded.

## Reusable lesson

Never gate blocking user-attention SMS (write_lock / setup handoff) on
`parent_workflow_id is None` — that root-only rule belongs only to per-spawn
lifecycle noise such as `agent_started`.
