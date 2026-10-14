---
id: 2026-10-14-raw-task-kickoff-exceeds-sms-provider-limit
date: 2026-10-14
title: Agent starts successfully but its full-task kickoff SMS exceeds Surge's body limit
surface: back-end
component: sms-lifecycle-notifications
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: SMS model surfaces omit the outgoing body contract; smsQueue.ts discards provider validation details; lifecycle notifications have no model correction loop
symptoms:
  - "Killed the stuck agent. New one is creating the Pro 500 Codex account"
  - "should be at most 1600 character(s)"
  - "Kickoff SMS exceeds captured Surge limit: 1762 > 1600"
  - "Notification message omitted a required link"
  - "failure before sending must be retryable"
tags:
  - sms
  - surge
  - agent-started
  - notification-length
  - whatsapp-mirroring
sources:
  - agent b2691042-3af3-4d97-82c7-73cbdfa2c8a0
  - commit b784977b0bf699c56bc67b063ae849a9cf5150fb
repro: back-end/src/tests/blackbox/send-sms.blackbox.ts testBoundary_notifyAgentStartedKeepsLongGoalInsideAgent
status: fixed
---

## Problem

Andy reported that the SMS supervisor claimed it started a replacement account-setup agent but no new agent appeared in the SMS thread. The screenshot contained the supervisor acknowledgement, without a follow-along notification.

Read-only production evidence disproves a missing spawn: agent `b2691042-3af3-4d97-82c7-73cbdfa2c8a0` was created at `2026-10-14T17:57:34.817Z`, with its Temporal execution identity recorded, before the acknowledgement at `17:57:35.110Z`. It initialized, planned, ran explore tools, and allocated browser session `bbf015bd-526e-5bd5-8697-cd50036732e1` at `17:59:04.845Z`.

Render's `SMS` log at `17:57:37.732Z` records HTTP 422 and the response `body: ["should be at most 1600 character(s)"]` for the kickoff send. The encrypted archived Surge response independently confirms `status_code: 422`, `success: false`, `event_type: agent_started`, and a 1762-character request body. The internal goal contains 1670 characters; the template plus concrete UUID tracking link makes 1762 characters. WhatsApp accepted the mirror: `SmsSession` contains the kickoff at `17:57:40.734Z` with a `wamid` provider ID. A later SMS requesting OpenAI sign-in was accepted by Surge (HTTP 201) and recorded at `18:04:59.135Z`; the agent was still ACTIVE with an unanswered authentication attention request when inspected. These provider acceptances do not establish handset delivery or read status. That later authentication problem is separate and is not diagnosed here.

Archive searches: `Killed the stuck agent New one is creating`; `sms supervisor claimed spawned agent missing start_new_agent`; `should be at most 1600 character`. Also searched case files for `1600`, `1,600`, and `Surge API error: 422`. The August 4 hallucinated-spawn case and August 3 purchase-delegation case are relatives by symptom, not recurrences: this incident actually committed the spawn. No prior case for an oversized kickoff was found.

## Diagnosis

Critical path: inbound SMS → supervisor `start_new_agent` → Agent/Temporal creation → worker `agent_started` notification → `dispatchByEventType` → `SMS_TEMPLATES.agentStarted` → Surge → mirrored delivery/transcript.

The supervisor's first request used an invalid $5 tool budget; it read the error, retried with $2, committed the spawn, and only then delivered the acknowledgement. The invalid first attempt did not prevent startup. Agent messages and browser inventory independently prove execution; the missing notification is downstream.

The captured provider response establishes a 1600-character complete-body contract. The SMS supervisor prompt and both send-message schema surfaces did not teach that contract. The kickoff template then copied the unbounded internal task into its notification. Lifecycle sends used templates without a corrective model loop, and several void notifiers ignored failed-send results while the endpoint reported success.

A second owned boundary prevented correction by the existing SMS supervisor: `smsQueue.ts` logged and archived the full 422 response but returned only `Surge API error: 422`. The actual next model input therefore lacked the provider's actionable body validation error. This was reproduced through the real supervisor endpoint: the fake provider replayed the captured 422 body; the next fixture required that text in the actual TOOL message and failed because it had been stripped. After returning the full error unchanged, the same blackbox passed and only the corrected accepted copy entered the session transcript.

Deepest owned class: model-authored messages lacked a shared destination contract and actionable delivery feedback. It affects direct supervisor replies, oversized lifecycle summaries, and approval notifications. The provider correctly rejected invalid input; this is our composition/feedback contract violation, not a provider outage or model-intelligence diagnosis.

Step 5b: stopped at the missing shared SMS delivery contract and real error feedback across message-producing surfaces. Tried the next-deeper class of every messaging channel using one universal SMS body rule. That fails to be coherent because channels have different body limits and capabilities. The final change teaches the SMS rule once, uses it on the relevant model surfaces, and enforces it at the notification delivery boundary without truncating tasks or changing unrelated channel contracts.

Golden references inspected: Hermes applies its 1600-character SMS cap (`hermes-agent/plugins/platforms/sms/adapter.py:43,90,162`) and exposes actual adapter failures to the calling model (`hermes-agent/tools/send_message_tool.py:541`, result serialization at line 294). Codex records tool results as `FunctionCallOutput` and requests another model turn (`codex/codex-rs/core/src/stream_events_utils.rs:399`). The correction loop converges on real tool-result feedback. Hermes's partial-delivery metadata (`hermes-agent/gateway/platforms/helpers.py:252`) and OpenClaw's lossless chunking (`openclaw/packages/markdown-core/src/chunk-text.ts:52`) explain why blind splitting was not selected: it introduces partial-send ownership without teaching message composition. Claude Code searches found no comparable SMS adapter.

Permanent owning-boundary repro, unchanged between baseline and draft fix:

```bash
cd back-end
bash scripts/run-blackbox-tests.sh send-sms
```

The permanent owning blackbox sends a harmless 1670-character task through the actual notification endpoint. It captures the Surge request, requires a body of at most 1600 characters with an intact agent link and without the internal-task sentinel, and verifies the persisted goal remains byte-for-byte unchanged. Its model fixtures require actual TOOL feedback for both the original 1762-character draft and an intentionally invalid 1601-character rewrite before returning valid copy.

With the original `outboundEvents.ts` implementation loaded, the unchanged suite observed 54 passed / 3 failed (1556ms): `1762 > 1600`, no corrected send after explicit 422, and HTTP 200 after an ambiguous failed notification. With the final correction implementation, the same command passed 57/57 (1400ms). Artifacts: `.context/test-runs/1792004618-246823-21329` before and `.context/test-runs/1792004666-255222-27535` after. The baseline used the real original notification owner with the permanent captured provider fixtures and current tests; it did not fail from a missing module, environment, or fixture setup.

Supervisor feedback reproduction: `bash scripts/run-blackbox-tests.sh sms-supervisor` failed 45/46 when the sender stripped provider detail (`1792004405-211468-31455`), then passed unchanged 46/46 with full error propagation (`1792004500-227525-886`). The failed fixture inspected the real next model input, not just an advancing scripted-response cursor.

Live model proof: `BLACKBOX_SMS_NOTIFICATION_REAL_LLM=1 bash scripts/run-blackbox-tests.sh send-sms` passed 58/58. The actual `rose-1-flash` client used Cerebras `qwen-3.8-27b`, accepted the assistant/tool-result history and strict notification schema, and generated a 244-character message with the required agent link (854ms live case). SMS transport remained mocked; no user was texted. This proves one live formatting sample and client compatibility, not universal model compliance. Deterministic length/link enforcement and bounded retries provide the runtime contract.

## Solution

The final implementation keeps descriptive templates and adds the general correction path requested by the user:

- `smsDeliveryContract.ts` is the source of the 1600-character complete-body rule. The SMS supervisor overlay, native tool description, actual structured-output schema, and notification writer all use it.
- SMS and MMS return full provider rejection details. The existing supervisor feeds them back as real TOOL results and retries its chosen message.
- Lifecycle notification delivery validates complete SMS body length and required URLs. Oversized or explicitly rejected copy is sent to `rose-1-flash` for a rewrite, with the actual error in a paired assistant/tool exchange. Fitting templates need no model call.
- At most two correction calls are shared across an event's channels. An accepted channel is never retried. Unknown transport outcomes and 5xx stop rather than risk resending an accepted message. Exhausted delivery failures propagate instead of returning a false success.
- Actual accepted copy enters the transcript. The full agent task and approval content remain in their original records.
- HTTP and Temporal ownership budgets are derived from the new bounded model/sender path: two 60-second model calls, four 30-second sends, and 30 seconds of backend overhead fit within a 270-second HTTP read budget and a 300-second activity envelope. Direct SMS and source lookup retain their existing behavior.

Verification so far: notification suite 58/58 including the live model sample, supervisor 46/46, mirrored-delivery suite, focused agent notification/planner/approval suites, prompt/registration structural checks, TypeScript, formatting, and lint. Full worker coverage passed 110/110 domains and frontend coverage passed 2749 tests; 46 deploy structural gates passed. The ordinary blackbox runners discover the new regressions; `/deploy` runs those runners under coverage. The first full backend coverage run passed 193/196 domains and all 266 unit files; the failing domains exposed the test-contract mismatch described below, a Steel profile rotation problem, and a stale Codex credential that fell back to an unfunded API key. Those deployment gates and production rollout remain pending; the owned SMS reproduction gap is closed.

10k-agent behavior: fitting notifications add no model request. Corrections are capped at two per event and share only local event state, with no new query, global lock, or cross-agent fan-in. Each notification retains its distinct agent URL. Provider failures remain visible and caller budgets own the finite correction path.

The user explicitly authorized the prompt limits and error-driven correction behavior in the follow-up recorded below. The earlier fixed-copy-only proposal was abandoned. Status is fixed for the owned SMS boundary on local reproduction and permanent regression proof; deployment completion must still be reported independently. The production account agent remains intact while awaiting authentication; evidence publication must not terminate it merely to satisfy terminal-recording requirements.

Evidence snapshots are private under `.context/rca-sms-2026-10-14/`. The latest original LLM request was reconstructed as `browser_use_step_37`, using the encrypted envelope's `created_at_ms`. The canonical publisher was attempted with the real production agent and refuses publication without a benchmark run UUID; no synthetic benchmark or terminal event was invented. The live production link is useful for opening the task but is not claimed as a terminal, publication-validated evidence viewer.

Adversarial review found two related ambiguity bugs once failures were surfaced: write-lock dispatch marked every thrown failure FAILED, and all-failed mirrored delivery inherited the SMS channel's definite rejection even when WhatsApp was ambiguous. The final code preserves typed delivery certainty, keeps unknown claims STARTED, and requires every failed channel to be definitely rejected before a claim can become reclaimable. The unchanged owning `send-sms-whatsapp-mirroring` suite first failed with two repeated SMS sends on the original service, then failed with six SMS sends and two WhatsApp attempts on the original mixed-channel aggregation (`1792005216-347924-2276`, 707ms). After both fixes it passed in 565ms (`1792005279-358369-179`): one SMS attempt for the single-channel unknown outcome, three rejected SMS attempts plus one ambiguous WhatsApp attempt for the mixed outcome, and no resend on a repeated request. Its positive control verifies an explicitly rejected claim can be corrected and retried. Final adversarial review passed after this proof and the live model smoke.

Full coverage found an existing waitlist test asserting that HTTP 503 was a definite SMS rejection. Its positive control now uses the captured 422 rejection class and adds unknown-outcome controls for 503 and 408. Extending the same controls to MMS exposed a related owned error-feedback gap: `response.text()` failure discarded the already received HTTP status. The unchanged expanded regression failed 7/9 before the shared SMS/MMS error-reader fix (`1792006397-716530-16848`), then passed 9/9 after it (`1792006444-725373-11737`, 462ms). The same final run passed the notification, mirrored-delivery, and supervisor domains. Both message transports retain status and body-read diagnostics; explicit 4xx rejection remains definite, while 408 and 5xx remain ambiguous.

Initial exact-HEAD deployment review found two retry-boundary defects, and independent review reproduced a third composition defect. The notification helper inferred required links from every URL in the internal task. Three research URLs totaling 1890 characters made a valid 125-character kickoff summary impossible to deliver, even though it preserved the canonical agent link. Required links now come from typed event composition: the run or approval link, exact authentication handoff link, or AgentCard setup link. Internal task URLs remain available for summarization without becoming mandatory notification text. The full stored task is unchanged.

Delivery certainty and correction eligibility are separate. Typed HTTP status now permits model correction for local validation or HTTP 400/422; 401, 403, 404, and 429 return their real failure without rewriting or resending. The unchanged owning `send-sms` suite failed 60/62 before these producer changes (`1792010857-1863011-28380`) and passed 62/62 afterward (`1792011000-1886332-24376`, 1891ms). Controls require the exact agent, browser handoff, and setup links, including real TOOL feedback when a model omits them.

Write-lock claims also distinguish preparation from transport. A failed phone lookup, attachment read, upload, or MMS eligibility lookup has not sent a notification and can safely release the claim for a repaired retry. The send-attempt callback runs immediately before the real Surge/Meta fetch, or after successful mock acceptance. Unknown outcomes and failures persisting an accepted SMS/MMS remain non-reclaimable. The permanent `sms-write-lock-claim.test.ts` was run byte-for-byte unchanged against the original `9cdf57c4` service and SMS sender, then restored fixed bytes: 4 preparation failures / 4 safety controls passed before (914ms), 8/8 passed afterward (895ms). Proof is in `.context/sms-presend-claim/owning-final-before.log`, `owning-final-after.log`, and `final-proof.json`. Independent review found no remaining blocker in the combined stabilization. Full deploy gates and production verification still apply after this local proof.

## Human feedback

The user requested `/rca`, twice asked to continue, then corrected the proposed fix: character limits must be in both the SMS agent prompt and the notification-generation model, with retries that feed delivery errors back to the model. This explicitly directs the final model-correction design instead of the earlier fixed-copy-only proposal.

## Reusable lesson

Teach message-generating models the destination's complete-body contract and return actionable delivery errors through real tool feedback before a bounded corrective retry.
