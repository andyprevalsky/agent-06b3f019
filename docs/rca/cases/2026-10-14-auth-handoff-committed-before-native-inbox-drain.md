---
id: 2026-10-14-auth-handoff-committed-before-native-inbox-drain
date: 2026-10-14
title: Browser auth handoff committed before its owned inbox poll drained
surface: agents
component: spawn_browser_agent_v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py native inbox admission before authentication assistance
symptoms:
  - request_user_assistance_for_authentication
  - tree stalled
  - Appended OTP user messages
tags:
  - auth
  - otp
  - native-input
sources:
  - agent 3caf15c9-92a8-4590-8bbb-93b4875f91fc
  - commit e576489611da771499791db3980d78a1db8c5c02
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

The original unchanged browser-auth-password-email-2fa task terminated FAIL in
581.7 seconds, with tree stalled (515s silent; threshold510s) and PAUSED instead
of COMPLETED. Earlier observations correctly reported pending. Preserve original
run6c8aa5ec-08e4-4789-933c-435d212caa23 and parent native cleanup receipts.
The browser requested human assistance although a native email OTP arrived
outside its model decision snapshot.

## Diagnosis

Path: site accepted password -> sent second-factor email -> minted inbox fetch
-> native OTP extraction/persistence -> browser model context -> assistance.
Parent backend.log12696 records accepted send20:04:06.109Z;12785 records one
minted inbox message20:04:08.684Z. Authenticated private site report records
only one second-factor issuance, to the saved-login/per-run minted recipient,
with code_sent and zero authenticated sessions. Native USER credential message
3bb79a97-9aae-488a-b9d6-ee01e9849f6a persisted20:04:08.694Z. Classifier dump
1792008253482-c0f44f6ec2e2 contains email_otp ref whose id equals that exact
recipient and a received OTP message; boolean correspondence verified without
printing code. Site issueEmailCode creates its challenge and sends the same code
to the same recipient in serviceSignIn.ts143-173. This establishes provenance;
raw original challenge-code equality cannot be rechecked because the private
report deliberately omits issued codes. Do not claim captured raw equality.

Step5 dump1792008253214-a116a32ac814 has17 messages and no received OTP USER
message, then requests assistance. Worker harvested count1 only20:04:16.386Z;
that is not its completion timestamp. Precise original future.done time is
unobserved. The reproductions cover both possible completion orders rather than
pretending the harvest timestamp establishes order.

Owning-boundary proof runs the real Temporal activity/browser controller,
real extraction/append/persistence/drain, genuine model tool stream and actual
assistance routing; external inbox/browser/provider edges are deterministic
substitutes. The inbox producer is released after model snapshot creation.
Fresh case explicitly waits for real native poll completion before decision
return; during_drain case returns decision first, then releases the producer
inside the existing owned drain. Baseline e576 fails both unchanged assertions:
only one model decision, assistance commits without the received input.
Candidate passes both, plus empty/stale/user-only assistance controls and
stream lifecycle/history protocol assertions. Repeated code is deduplicated,
and second decision can still request assistance exactly once.

Command from isolated root: agents/venv/bin/python
.context/email-2fa-rca/run-focused.py. Baseline output: native handoff controls
failed ['fresh', 'during_drain']; candidate: PASS native OTP handoff boundary
and controls. Test is registered in the permanent spawn-browser-agent-v3 suite;
full suite validation pending.

Archive searches were request_user_assistance_for_authentication and email OTP
minted inbox. Today's handoff/pending-verification case and older Gmail lookup
case are relatives, not demonstrated recurrences. Prompt approved->immutable
browser_use.py diff is empty. No prompt causation or model-intelligence claim.

Deepest coherent class: committing human transfer from an obsolete decision
snapshot while authoritative eligible native input is stranded at shutdown.
Next broader rule considered: invalidate every action on any unseen input.
That lacks relevance policy and can suppress necessary app approvals or repeat
executed writes, so it is not coherent. This repair uses natural input admission,
not new LLM instructions. No prompt edit is proposed.

Golden inspected analogs: OpenClaw
openclaw/src/agents/embedded-agent-runner/run/attempt-stream-prepare.ts198-208
lets queued input win over finalization; Codex
codex/codex-rs/core/src/tasks/regular.rs114-123 continues with pending input
except terminal errors; Hermes hermes-agent/agent/turn_iteration_prep.py175-181
admits steering received during the prior call; Claude
claude-code-src/src/query.ts1550-1585 drains eligible addressed notifications
following tool batches (no identical pre-handoff guard found).

## Solution

Move the already-owned OTP drain before assistance commit, using its existing
bounded two-second grace and cancellation semantics; no new timer or email
fetch. If the existing eligible queue has unseen input, close the superseded
streamed tool ERROR, discard stale observation prefetch and let the next normal
turn consume the actual message. Do this before reasoning/action summaries,
so abandoned handoff is not persisted as executed. If no new input, normal
assistance continues; the refreshed model can still require user-only approval.
This unifies control-transfer and shutdown producer ownership instead of adding
site/provider/benchmark classifiers. At10k agents it creates no new polls or
background tasks; handoff can now incur the already-existing up-to2s drain.
Cancellation during persistence retains the existing ownership semantics; queue
availability is not advertised as a new durable-completion guarantee.

First candidate16abaf295 unchanged local benchmark passed100.6s, agent
7084b8da-2edd-4fc4-a34b-e423b96278ba. Both benchmark and stack native cleanup
receipts clean. Refined drain candidate and app-approval benchmark pending;
do not treat first candidate as final source verification or deploy-ready.

## Human feedback

User required first phase read-only and timely evidence, isolated worktree/DB,
no changes to live suite, original clocks, instructions or Freedom; no prompt,
timeout, assertions or task weakening. User confirmed reproduction/code scope,
then corrected pending status to native FAIL and required proof of actual poll
completion order, including completion during existing drain and protocol-valid
retained history. Parent alone routes deployment; no push or merge by RCA worker.

## Reusable lesson

Drain owned authoritative input before committing control transfer, and refresh an obsolete decision through the normal input path.
