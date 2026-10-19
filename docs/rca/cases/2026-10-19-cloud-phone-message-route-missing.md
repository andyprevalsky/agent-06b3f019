---
id: 2026-10-19-cloud-phone-message-route-missing
date: 2026-10-19
title: Approved personal messages still used the Mac relay with cloud iPhone enabled
surface: agents
component: message-person
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: message_person queued every imessage through the Mac relay without cloud transport selection
symptoms:
  - Approved user messages had no cloud phone delivery path
  - A physical send acknowledgement did not prove a newly sent message
tags:
  - iphone
  - imessage
  - delivery
  - idempotency
sources:
  - memory: .context/phone-harness/cloud-message-python-red.log
  - memory: .context/phone-harness/messages-control-red.log
repro: back-end/src/tests/blackbox/iphone-control.messages.cases.ts
status: open
---

## Problem

The user required personal messages to use the dedicated cloud phone when enabled. The existing message_person path always queued the Mac transport. A working standalone phone tool and a successful manually driven message did not implement that route. The original independent inbound SMS proof also established only one received message, not outbound tool integration.

## Diagnosis

The path is approved draft → message_person queue activity → /imessage/queue → Mac relay. The first missing boundary was server-side transport selection and an immutable cloud task binding. A prompt-only redirect would leave the actual tool route and retry behavior unchanged. Stable browser task identity alone cannot prevent another final-send decision after an uncertain physical response.

Archive searches were `iMessage Mac relay cloud phone routing duplicate send` and `phone Contacts startup verification missing`. The cloud capability/relay case is a relative, not the same defect; its eligibility filter did not implement personal-message delivery. The existing private-phone and durable-custody cases remain applicable to the new operation. No claim of causal root-route red is made: the parent started the queue prototype before the new integration assertions. The separate Python queue-provider preservation and new broker-send owning failures were executed before their respective fixes. Logs retain their original results.

## Solution

The existing queue records the selected transport, preserving `mac` as the migration default. Only the persisted, enabled account uses `phone_harness`; the flag-off path retains its prior response shape and makes no eligibility lookup. Mac pop and acknowledgements cannot consume cloud rows. One unique browser-task binding and one unique final-send operation bind each approved intent; recipient and body cannot change on an idempotent retry.

The already-approved exact draft is delegated to the existing browser manager under a stable child call ID. The actual browser task binds to the intent after initialization and before model execution. The ordinary phone tools navigate and compose. A dedicated send operation uses current owned observations and a fixed semantic verifier to match the approved recipient/body and an enabled Send control. The broker records dispatch and its operation ID atomically before the physical tap. Post-dispatch mutations are denied; reads and verification remain possible. A separate observation-based verifier distinguishes sent, failed and unknown. Only the authoritative queue receipt can complete message_person successfully; model completion prose is not delivery proof.

No change is made to AgentPhone or email transport. No fallback sends the message through a second transport. All new phone behavior remains behind the existing rollout gate. Lookups and locks are scoped to one task, device or queue row; unique task/send indexes avoid user-history scans at 10,000 agents. The single physical device is intentionally serialized by its existing FIFO.

## Validation and limits

The permanent owning cases exercise route selection, immutable payload/task binding, exclusion from Mac consumption, before-input dispatch, duplicate operations, unknown outcomes, private-value masking, and observation-based completion. The final normal eight-domain run `1792393545-537565-27025` passed all domains (including 81 phone-control cases); the provider suite passed 90 tests, structural layering passed 1,679 checks, and backend build and scoped lint passed. The Python message-person, browser and user-context suites passed together in 62.4 seconds. The unchanged full Rose browser suite passed 114 cases in 9.7 seconds, including the existing five real-model AutoFill branches; these are not live Google approval or outgoing-message proofs. The full frontend run passed 2,887 tests with three existing skips, and fifteen desktop/mobile setup visual cases passed. The actual SQL migration was also exercised against a temporary table in a rolled-back local transaction: legacy rows defaulted to Mac and duplicate task/send bindings were rejected.

The verifier provides semantic UI binding, not cryptographic app attestation. A submitted tap is not recipient delivery. Epoch changes after an unknown send remain unconfirmed and never authorize a resend. A malicious or incorrect model using unrelated generic phone actions before the approved commit is not claimed impossible; this adapter's supported send path uses the dedicated operation. No real outbound tool-run or Google device-approval pass is claimed by these offline tests. This case remains open until the integrated live criteria are verified.

## Human feedback

The user required cloud-only behavior, unchanged main trajectories when disabled, approval only at real authentication blockers, and actual independent message validation. Parent technical review is not additional human feedback.

## Reusable lesson

A new device tool does not replace an existing delivery transport. Bind the approved intent and physical send durably, and distinguish attempted input, observed send, and recipient delivery.
