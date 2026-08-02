---
id: 2026-07-13-approval-read-model-stale-until-temporal-completion
date: 2026-07-13
title: The approval response endpoint left approval messages IN_PROGRESS until Temporal replied, so the query box never came back
surface: back-end
component: agent-attention-requests
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the attention-request response endpoint — it persisted AgentAttentionRequest.userResponse but left the message read model driving derivePendingApproval at IN_PROGRESS
symptoms:
  - query box does not return after accepting or rejecting an approval
  - approval chip stays mounted after the user responds
  - "Resolved approval message should be FINISHED, got IN_PROGRESS"
tags:
  - approvals
  - read-model
  - temporal
  - transaction
  - front-end-chip
sources:
  - PR #763
repro: back-end attention-request blackbox (pre-fix 34/36, post-fix 36/36) plus frontend Accept/Reject approval-routing tests
status: fixed
---

## Problem

After a user answered an approval, the approval chip stayed mounted and the query
box was never restored, on both the Accept and the Reject path. Backend
reproduction failed with `Resolved approval message should be FINISHED, got
IN_PROGRESS` for both Respond and Reject; pre-fix the attention-request blackbox
was 34/36 and post-fix 36/36.

## Diagnosis

The response endpoint persisted `AgentAttentionRequest.userResponse`, but the
message read model that `derivePendingApproval` reads stayed `IN_PROGRESS` until
Temporal later emitted a completion event. The front-end refreshes agent detail
immediately after responding, so it re-read the stale approval and correctly
concluded an approval was still pending. The defect is a write-path split: one
store (the attention request) was updated synchronously while the store the UI
actually derives from (the messages) was updated only asynchronously by a
different actor. Any consumer reading between the two writes sees an
inconsistent system, and the FE's immediate refresh guarantees it lands in that
window.

## Solution

Update the attention request and all matching in-progress approval messages in a
single database transaction, marking approval and gate tool messages finished on
both the approve and reject paths, and only signal Temporal after that read-model
state is committed. Frontend and backend regressions cover Accept and Reject
query-box restoration. Ordering the commit before the signal removes the window
entirely rather than shrinking it, so it holds regardless of how long Temporal
takes to acknowledge.

## Human feedback

The adversarial RCA review rejected the first attempt: an initial
component-local frontend workaround was replaced with the transactional backend
fix, and only then did the review pass. The lesson the review enforced is that a
stale read model must be fixed at the write boundary, not papered over in the
component that noticed it.

## Reusable lesson

If a UI refresh immediately after a mutation reads stale state, commit every
store the UI derives from in one transaction _before_ signaling the async actor —
and reject component-local workarounds for read-model bugs.
