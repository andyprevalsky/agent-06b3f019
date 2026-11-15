---
id: 2026-11-15-iphone-paused-agent-released-lease-before-pending-phone-auth
date: 2026-11-15
title: Pausing the setup agent for owner phone auth released the iPhone lease within seconds, so the owner's request had no live phone
surface: back-end
component: iphone-lease-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/iphone/repo.lifecycle.ts reconcileActive — closes the lease RELEASED for any PAUSED agent before the pending phone-auth branch that grants the bounded user grace
symptoms:
  - lease RELEASED after request_user_assistance
  - device CLOSING
  - owner request has no live phone session
  - Paused agent still holds the phone
tags:
  - iphone
  - lease
  - attention-request
  - phone-auth
  - paused-agent
sources:
  - PR #2123
  - agent c1ad83f7-901b-5dca-9fa6-8977975d5f44
  - agent f1802539-7e5d-5a76-9028-133ad4e9fb75
  - PR #2101
repro: back-end/src/tests/blackbox/iphone-control.device.cases.ts "paused agent keeps the phone for its own pending phone auth, then the bounded grace admits the next waiter"
status: fixed
---

## Problem

Prod 2026-11-15, live proof of PR #2101 (setup agent c1ad83f7, lease 83e3484c). The agent raised a phone-auth request (attention created 00:26:38.976Z) and paused (00:26:47.262Z). The lease went RELEASED at 00:26:48.781Z, while the attention was still PENDING, and the device went CLOSING. The owner's request therefore had no live phone to act on. Lease c5b5d796 on 2026-11-14 shows the same pattern: attention 18:39:49Z, lease RELEASED 18:40:51Z, attention still PENDING.

## Diagnosis

`reconcileActive` runs on every device/lease read. Its rule "A paused agent cannot act on the phone; it must not starve the FIFO queue" (`if (agent.status === 'PAUSED') return closeLease(..., 'RELEASED')`) runs before the pending-auth branch. That branch already keeps a lease with an unanswered phone-auth attention for the bounded `USER_CONTROL_TIMEOUT_MS` (15 min) grace via `expireHold`. Because the paused check comes first, the grace branch is unreachable exactly when it matters: the agent pauses because it asked the owner for phone auth.

Why possible: commit dcd4c57fcc (11-09) fixed a 3-day block, where a paused agent's unanswered auth hold never expired, in two ways at once: an immediate release on pause, and a 15-minute bound on pending-auth holds. The bound alone fixes the starvation, but the immediate release also removes the phone from the very request the pause is waiting on. The existing blackbox case pinned the immediate release.

## Solution

Release a paused agent's lease immediately only when the lease has no phone-auth attention. A pause for the lease's own pending auth falls through to the existing pending-auth branch: held for the 15-minute user grace, then expired, which admits the next waiter. Answered or rejected auth keeps its existing transitions; a still-paused agent is then released on the next reconcile. The regression asserts that the paused pending-auth lease is held within the grace, released after it with the waiter admitted, and that a paused agent without pending auth still releases at once (negative control). Per-lease constant work under the existing device lock, so there is no 10k-agent impact.

Shipped: PR #2123 (merge 5860080c279a), production lanes PASS; regression RED 172/173 -> GREEN 174/174 x5. The 2026-11-15 live proof did not need an owner pause, so the hold is proven by the blackbox regression only.

## Human feedback

Coordinator relay (11-15): Andy requires the saved-password path to work with no manual typing; ship this lease fix.

## Reusable lesson

When a hold has a bounded grace for a pending owner action, never let an earlier blanket release rule pre-empt it; order the specific pending-action case first.
