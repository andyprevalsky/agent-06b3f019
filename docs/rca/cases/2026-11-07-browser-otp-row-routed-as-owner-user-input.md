---
id: 2026-11-07-browser-otp-row-routed-as-owner-user-input
date: 2026-11-07
title: A browser task's native OTP row was signalled to its owner as user input, waking wait_for and feeding the code to response-schema feedback
surface: back-end
component: agent-message-routing
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentMessageService.ts postMessage routing gate (isAgentAuthoredRow) signalled receive_user_response for an internal USER row scoped to a child work stream (metadata.subAgentId), which every model-context consumer (contextScope / context_scope.py) treats as not the owner's
symptoms:
  - Woken by a new user message after 7.9 minutes. Agents: - /root/kabuki_checkout: running
  - Received user response (length=208)
  - Recently received email OTP code from Instacart on a concurrent hotel-booking root
  - response_schema regeneration LLM call right after an OTP row, with the code in its input
tags:
  - otp
  - wait-for
  - message-routing
  - context-scope
  - response-schema
  - concurrent-copies
  - shared-inbox
sources:
  - agent 50ec6c94-041a-44e9-b24e-4c6728d56635
  - agent b761b695-d243-4868-9c3e-f06e3af8756a
  - agent 8f717909-a200-4a3c-8002-fca738dac136
  - fleet run 20261107-183106-905815
  - fleet run 20261107-183106-905808
  - fleet run 20261107-184604-1228421
  - commit 268e9550b057938a18f5ee6eb4911d95765fa4fd
repro: back-end/src/tests/blackbox/agents-agent-messages.cases.ts
status: fixed
---

## Problem

Descend run descend-failed-neverrun-20261106, epoch 18 (cluster H-62). The
browser-hotel-booking r1 root 50ec6c94 was in `wait_for` on its browser child
when two Instacart email OTP codes (652339 at 19:00, 982630 at 19:08) — requested
by concurrent Instacart copies on other guests that share the one test user's
Gmail inbox — reached it. Each produced, on the hotel root:

- a USER row `Recently received email OTP code: - Code: … - From: Instacart …`
  with metadata `{subAgentId: f5fed10b… (the hotel browser task), credential_ref: {kind: email_otp}}`
  (POST /api/agents/50ec6c94…/messages -> 201, 19:00:08.0 and 19:08:14.8);
- a Temporal `receive_user_response` signal on the root workflow
  (worker.log `Received user response (length=208)` at 19:00:08.60 and 19:08:14.89;
  208 = the exact OTP row text length);
- `wait_for FINISHED: Woken by a new user message after 7.9 minutes` (and 8.0 min);
- a root `response_schema` regeneration LLM call whose dumped input contains the OTP
  text and the code (dumps 1f99ccaf8e12, c31bd526a135);
- an extra root turn that, at 19:08:24, sent the busy browser a status-request message.

The root's own execute_loop contexts at 19:00:10, 19:08:19 and 19:08:25 do NOT contain
the OTP text: the row is filtered as the child's work stream. The root woke for a
"user message" it could never read. Every epoch-18 browser task that ingested an OTP
did the same to its root: one code fanned out to 4 copies (652339) and to 6 browser
tasks in 6 copies (982630), each waking its root and regenerating its response schema.
Not causal for the task failures (H-60 CPU steal, H-61 DOM timing) but a correctness,
isolation and secret-hygiene defect.

## Diagnosis

Path: site mails an OTP -> user's inbox (one Gmail for all copies, as for one real
user) -> each running browser task's per-step poll `fetch_recent_otps(user_id)` ->
`_append_new_otp_user_messages` (native USER turn for the browser + durable
credential-ref row) -> `save_browser_credential_ref_message(role=USER,
metadata.subAgentId=task)` -> backend `postMessage` -> `routeUserMessage` ->
`receive_user_response` -> workflow `_note_wait_wake("user_message")` and
`_record_response_schema_feedback(text)`.

Binary search: the inbox read and the browser's own native delivery are by design
(post-task-start, LLM-gated "Use this code only if the current site requested an
email OTP"). The row is correct data for the browser's transcript. The first bad
point is the backend routing gate: `isAgentAuthoredRow` excluded only
agentNotification/agentMessage/environmentContext rows, so an internal USER row
scoped to a child (`subAgentId`) was signalled to the owner as the user's input.

Why 1: the root woke because postMessage signalled `receive_user_response` with the
OTP text. Why 2: the routing gate's notion of "not the owner's user input" did not
include the child-work-stream scope that the shared context-scope contract
(back-end/src/providers/chat/contextScope.ts, agents/helpers/context_scope.py,
shared fixtures) and `poll_new_messages` ("Browser internals ... are not user
instructions") already use; two classifiers of the same row disagreed (model context:
child's; router: owner's). Why 3 would be "USER role is overloaded for native child
input", a deliberate transcript design (the browser conversation shows the OTP as a
user turn); stop at Why 2. The fix at Why 2 also prevents the siblings that share the
routed signal: lifting a user pause (unstamped writes go through
deliverUserMessageToWorkflow), triggering a chat-mode turn or terminal-agent
reactivation on a root without a running workflow, and code text entering
response-schema feedback.

Local repro (owning backend blackbox, local DB victoria_rca-H-62, Temporal capture
fake): `CONDUCTOR_WORKSPACE_NAME=rca-h62 CONDUCTOR_PORT=4610 ROSE_USE_SYSTEM_PG=true
env -u FLY_APP_NAME bash back-end/scripts/run-blackbox-tests.sh agents`. On
268e9550b0: 306 passed / 1 failed, the new case: `a browser task's OTP row must not
signal the owner as user input, got [receive_user_response "Recently received email
OTP code:\n- Code: 652339 …" (stamped), the same (unattributed), "Use the saved card
instead." (control)]`. After the fix the identical command passes 307/307.

Archive searches: "Recently received email OTP code concurrent agent wrong site",
"wait_for woken by a new user message credential ref otp root", "otp predates browser
task stale code other task same user". Relatives only (2026-10-15 OTP reference
retry, 2026-10-14 handoff before inbox drain, 2026-10-16 handoff OTP contract,
2026-03-16 first Gmail account, commit 99c9e2d5cb pre-task OTP skip); novel boundary.
Their contracts are untouched: delivery dedup, pending-reference retry, drain-before-
handoff and the pre-task skip live in the agents OTP path, which is unchanged; the
row is still persisted exactly as written.

## Solution

`isAgentAuthoredRow` (the postMessage routing gate) now also returns true for internal
rows the shared `isInternalSubagentMessage` classifies as a child's work stream, so a
browser task's OTP row is stored for its transcript but never signalled to the owner.
Ordinary workflow USER rows, user messages and Browser-composer targeting are unchanged
(control in the same test). Golden reference: claude-code-src/src/query.ts:1560-1578
scopes its shared command queue by agentId — the main loop drains only
`agentId === undefined`, a subagent's items never wake or feed it; the fix converges.

10k agents: one in-memory metadata check per POST; removes, per ingested OTP per
concurrent browser task, one Temporal signal, one wait wake, one root LLM turn and one
response-schema LLM call. No new query, subscription, lock or shared state.

Residual (not fixed here, documented): every running browser task of a user still
ingests every fresh OTP in that user's inboxes (no requesting-task scope; gated only by
age and the LLM instruction). Two concurrent copies logging into the same real account
with one inbox cannot be disambiguated by routing (fixture-level account collision);
production users with concurrent browser tasks see unrelated codes in the browser
context. Sender-domain/realm scoping would be the next fix and needs its own evidence
of a misused code (sender domains often differ from site domains).

## Human feedback

None recorded.

## Reusable lesson

Route a message to an agent's loop only when the same scope rule that builds that agent's model context says the row is the agent's own input.
