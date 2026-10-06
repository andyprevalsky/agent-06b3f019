---
id: 2026-10-02-cooperative-approval-handoff-leaves-attention-pending
date: 2026-10-02
title: Cooperative approval handoff closed the chip with DEPLOY_INTERRUPTED but left AgentAttentionRequest.userResponse NULL, so SMS approved a stale attn_id
surface: agents
component: request-user-approval
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/request_user_approval/service.py request_user_approval_direct — GenerationHandoffRequested yields and continue_as_new, then the replacement run creates a new attn_id instead of re-waiting the original row (wait_for already resumes; approval did not)
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
repro: agents/tests/blackbox/request_user_approval.blackbox.py::test_direct_retry_after_handoff_reuses_request_and_consumes_late_signal (via python scripts/run_blackbox_tests.py request-user-approval)
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

Step 5a: why was a stale approve possible? Because the replacement run created
a new attn_id and waited on that key. `_signal_responses` already migrates
across continue_as_new; the wait identity did not. `wait_for` already resumes
its original target; approval did not. Why did three more orphans appear?
Because `dag_executor` treated generation_handoff as `success=True`. Stop at
migrating the wait identity; DAG dependents are an amplifier.

Next-deeper class tried: fence the old row with DEPLOY_INTERRUPTED so SMS
cannot target it. That is the dead-generation closer (`commitReplyToAgent`
treats that sentinel as `fencedApproval` and may restart). On a live
continue_as_new it drops a real user approve. Failed to be coherent for a
replacement that will keep running.

Gate sibling (`raise_gate_direct`): leave on the fence/seal closer. Closing a
deduped gate via `/respond` would `signalAllWaiters` and can strand foreign
occupants (2026-08-19).

## Solution

Do not fence the row on cooperative yield. Stash the original `attn_id` on the
workflow (`_pending_approval_resume`), persist it in continue_as_new
`runtime_state` next to `_signal_responses`, and have
`request_user_approval_direct` / `RequestUserApprovalManager` reuse that id on
the next wait instead of POSTing a new attention row. A late SMS approve of the
original id lands in the migrated `_signal_responses` map and unblocks the
resumed wait. Conversation scan (`pending_approval_request_to_resume`) is the
same fallback `wait_for` already uses when resume state is missing.

`execute_dag` still returns `status=generation_handoff` instead of marking the
task COMPLETED, so dependents do not open extra pending rows. `AgentWorkflow`
`continue_as_new`s immediately.

`DEPLOY_INTERRUPTED` on the attention row stays the dead-generation fence
(`commitReplyToAgent` treats it as `fencedApproval` and may restart). Do not
write it on a live replacement.

10k-agent behavior: no extra resolve activity; one reused row per wait
(O(waits), not O(agents)). No new fan-in, subscriptions, or shared mutable state.

Local repro (identical command pre/post):

```
cd agents && python scripts/run_blackbox_tests.py request-user-approval dag-executor
```

Pre-fix: `direct_retry_reuses_request` created a second attn_id and ignored
the late signal on the original id. Post-fix: retry reuses `req-stale-prod`
and returns `Approved. Go ahead and make the call.` DAG dependents still do
not start.

### October 2 integration recurrence: cancellation closed the chip before resume identity was saved

The required merge of `fd2427a7347de27cdb9bb4744cf18d2aee37ae9b` with
`42ffa4d57b8f973ac1f87fb2dc214fc68bd8c9f2` combined this same-attention-ID
handoff repair with the browser-owned `close_on_cancel` chip closure recorded in
[the September 11 archive case](2026-09-11-cloud-archive-preceded-browser-cleanup.md).
The resolved intermediate closed an unanswered chip with its existing neutral
FINISHED interruption event. The incoming transcript scanner correctly treats
an ordinary FINISHED chip as completed, so it could no longer recover that
unanswered row for continuation. Explicit generation-handoff stashing alone did
not cover cancellation of a sibling approval wait.

One call now saves the original request ID and question before the existing
no-decision interruption event is delivered. Signal consumption clears that
resume entry before response-completion awaits. Cancellation after a genuine
approval or rejection therefore finishes the same known decision event and does
not re-stash it. The original caller still receives `CancelledError`; this does
not answer the attention row, create another request or SMS notification, change
model-visible text, or change generic callers' default cancellation behavior.

The new registered owning case,
`test_direct_cancel_preserves_unanswered_resume_only`, gates real task
cancellation after the opening event has been recorded. It requires continuation
to reuse the original attention ID, one request creation and one SMS notification,
then clear the resume entry after approval. Its approved and rejected completion
arms require the consumed signal to remain consumed, no resume entry, and
identical replayed terminal events.

The identical test failed with `Canceled unanswered approval lost its original
attention request` in 0.0215 seconds against the preserved resolved intermediate
module, then passed in 0.0205 seconds with the one-call repair. This is an
integration-module reproduction, not execution of an unchanged whole commit.
The executed test SHA256 was
`ad5e47fd580a2309ad6da2bdb049fccbd586dcbee5fcd8c57f136c290726319a`;
formatting only that new function produced the AST-identical final fixture
`c5b63f6d2c1e88431173db5e9f9111eb21f41189db3f59a1fcbdb0dd503a8d8f`.
An earlier fixture-only dataclass-method error is preserved separately and is
not counted as causal evidence.

Executed command, from `agents/` with its Python 3.11.9 venv activated:

```sh
python ../.context/acceptance/proof110-required-main-browser-review/owning-approval-interoperability.private.py <receipt> [preserved-intermediate-module]
```

The baseline argument loads the actual preserved resolved service module for
RED; GREEN uses the merged production module. The permanent test is also the
27th case in the existing `request-user-approval` domain: its complete domain
passed 27/27 on the final fixture bytes. Seventeen existing browser integration
controls and 25 credential cases passed, retaining task identity, one terminal,
rejection feedback, raw-cancellation propagation and task-scoped cooperative
handoff behavior. The standard agents coverage gate remains a separate required
result; these focused checks award no benchmark or fleet credit.

Archive searches used both the actual assertion and the behavioral query
`approval cancellation generation handoff attention resume chip`. This case is
the owning recurrence; the September 11 chip-closure repair is the interacting
relative. Search results, preserved modules, unchanged RED/GREEN, formatting
identity, source hashes and checks are retained under
`.context/acceptance/proof110-required-main-browser-review/`.

## Human feedback

The first proposed fix closed the handed-off row with DEPLOY_INTERRUPTED so
SMS would stop targeting it. The user rejected that class: this is not a
DAG-only bug, and a live continue_as_new must migrate the original approval
request the way wait_for already resumes its target. Fencing the row is the
dead-generation closer; using it on a replacement run drops a real approve.


For this integration, the user reiterated that every quick test must be cemented
in `/deploy`, and that larger additional verification needs approval. The new
case is registered in the owning domain's `run_all_tests`; `/deploy` Step 4g
runs it through canonical agents coverage. The existing Step 4s registration
guard, `python3 agents/tests/structural/structural_test_registration.py`, passed
all three checks, including discovery of every blackbox test. No new suite or
deploy stage was added.

## Reusable lesson

When an in-tool approval wait yields for continue_as_new, migrate the original
attn_id onto the replacement run — creating a new row is how SMS approves a
stale id and the live wait never moves; fencing the row is only for dead generations.
