---
id: 2026-10-02-cooperative-approval-handoff-leaves-attention-pending
date: 2026-10-02
title: Cooperative approval handoff closed the chip with DEPLOY_INTERRUPTED but left AgentAttentionRequest.userResponse NULL, so SMS approved a stale attn_id
surface: agents
component: request-user-approval
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/request_user_approval/service.py request_user_approval_direct — GenerationHandoffRequested handler posted DEPLOY_INTERRUPTED on the chip and re-raised without resolve_attention_request_activity
symptoms:
  - new code version deployed, retry this tool
  - The sms agent approved but didn’t respond to the approval request
  - AgentAttentionRequest.userResponse stays NULL after a FINISHED approval chip
  - 'Approved. Go ahead and make the call.'
  - '✓ User approval received' never appears after an SMS approve
tags:
  - request-user-approval
  - generation-handoff
  - sms-supervisor
  - call-phone-number
  - attention-requests
  - deploy
sources:
  - agent 262669d8-1d99-4fe5-991b-dda0c7c89f85
repro: agents/tests/blackbox/request_user_approval.blackbox.py::test_direct_generation_handoff_resolves_attention_request (via python scripts/run_blackbox_tests.py request-user-approval)
status: fixed
---

## Problem

SMS-sourced root agent `262669d8-1d99-4fe5-991b-dda0c7c89f85` (Call Mensho Tokyo SF)
parked on `call_phone_number` → `request_user_approval_direct` at `00:35:49Z`
(`attn_id=cmuq8f9bo01fe4onil35n28g1`). A generation handoff at `00:57:13Z` closed
the chip with text `new code version deployed, retry this tool` and title still
`🔐 Requesting user approval`. `userResponse` stayed NULL.

The DAG treated `{success: true, generation_handoff: true}` as task success and
started three more `call_phone_number` approvals (`00:57:23Z`, `00:57:42Z`,
`00:57:58Z`). Each handed off in ~0.7s and also left `userResponse` NULL.

A fifth live request (`cmuq98lzx003zq7o8ka335ngs`, `00:58:39Z`) actually waited.
At `01:19:01Z` the SMS supervisor posted USER `Approved. Go ahead and make the call.`
and wrote that text onto the **oldest** stale row (`cmuq8f9bo…`, updatedAt
`01:19:01.907Z`). The live wait keys on `request_id in _signal_responses`, so the
stale-id signal was ignored. The live row was resolved only at `01:36:36Z` with
`userResponse=Approved` — the FE chip default
(`respondToAttentionRequest(requestId, 'Approved')` in
`AttentionMessageWrapper.tsx`), which does not post a USER row. Different
response text proves a second writer; the user had to approve again in the app
after SMS did nothing.

Archive searches: `sms agent approved but didn't respond to the approval request`,
`late SMS approve no response`, `userResponse null pending attention request
GenerationHandoff`, `new code version deployed retry this tool attention request
still pending`. Relatives (different first-bad boundary):
`2026-08-19-deploy-fence-correlates-attention-requests-through-tool-metadata`
(backend seal/fence close missed auth-assistance metadata),
`2026-09-29-force-clear-kills-approval-blocked-cutover-stragglers` (cooperative
yield added; did not close the attention row). Novel gap: the cooperative yield
path never called the resolve activity.

## Diagnosis

Critical path: `call_phone_number` (`requires_approval`) →
`request_user_approval_direct` → `wait_condition_or_generation_handoff` →
`GenerationHandoffRequested` → FINISHED chip → DAG marks success → dependents
create more pending rows → SMS `fetchPendingAttentionRequests` (`userResponse:
null`) → `reply_to_agent` signals the stale `attn_id` → live wait ignores it.

Binary search:

1. Midpoint (approval chip at `00:57:13Z`): text is DEPLOY_INTERRUPTED, title is
   still "Requesting user approval" — handoff path, not user approval.
2. Attention row for that chip: `userResponse` still NULL after the chip finished
   (first-bad write omitted).
3. SMS approve at `01:19:01Z` wrote the stale row and an empty-looking USER
   message whose text is `Approved. Go ahead and make the call.` — supervisor
   did approve, just the wrong id.
4. Live row unchanged until `01:36:36Z`, then `Approved` from the FE chip
   (no USER row — `respond()` does not create one).

Step 5a: why was a stale approve possible? Because cooperative handoff does not
write `userResponse`. Why did three more orphans appear? Because `dag_executor`
treated generation_handoff as `success=True`. Stop at those two owned rungs.

Next-deeper class tried: route every attention-creating park through
`closeInterruptedAttentionRequests` (the seal/fence primitive). That is
generation-wide, skips foreign `gateWaiters`, and has no agent-facing activity
because it is for sealed/replaced workflows. Calling it from a still-running
continue-as-new would also close a later live wait on the same workflow id.
Request-scoped `resolve_attention_request_activity` (existing `/respond`) is
the coherent close for one yielded wait. The leftover Temporal signal is keyed
by the old `request_id` and is not consumed by the already-exited wait.

Gate sibling (`raise_gate_direct`): same chip-without-row-close handler.
Closing a deduped gate via `/respond` would `signalAllWaiters` and can strand
foreign occupants (2026-08-19). Cooperative yield is not a seal — the
replacement `continue_as_new` can join the still-pending gate. Leave gates on
the fence/seal closer. Do not close them with `/respond`.

## Solution

`request_user_approval_direct` and `RequestUserApprovalManager.execute_tool` call
`resolve_attention_request_activity` with `DEPLOY_INTERRUPTED_TOOL_MESSAGE` before
re-raising `GenerationHandoffRequested`. That is the existing request-scoped
`/respond` path (writes `userResponse`, signals the old `request_id`). The chip
and the attention row now terminate together, so SMS cannot approve a cut-over
request. Resolve failures are logged and still yield — cutover must proceed;
the activity already retries three times.

`execute_dag` returns `status=generation_handoff` instead of marking the task
COMPLETED. `AgentWorkflow` `continue_as_new`s immediately — no dependent phone
approvals, no post-DAG verifier on a deploy interrupt.

Sibling failures prevented: any `requires_approval` tool (not just
`call_phone_number`) that yields mid-wait; DAG dependents that would otherwise
open more pending attn_ids.

10k-agent behavior: one extra resolve activity per handed-off approval (O(waits),
not O(agents)). No new fan-in, subscriptions, or shared mutable state.

Local repro (identical command pre/post):

```
cd agents && python scripts/run_blackbox_tests.py request-user-approval dag-executor
```

Pre-fix: `direct_handoff_resolves_attention` and
`execute_dag_generation_handoff_does_not_start_dependents` failed (no resolve
call; DAG started the dependent). Post-fix: both domains PASS.

## Human feedback

None recorded.

## Reusable lesson

When an in-tool approval wait yields for generation handoff, close the
AgentAttentionRequest row with DEPLOY_INTERRUPTED — a FINISHED chip with a still-pending
row is how SMS approves a stale attn_id and the live wait never moves.
