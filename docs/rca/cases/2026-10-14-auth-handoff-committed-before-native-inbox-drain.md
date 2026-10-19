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
full canonical domain passed in51.0s, including every registered new control.

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
receipts clean. Refined candidate aadfc21406cab94073b21390b6efb252a6b8abe4 passed both
unchanged canonical tasks: email2FA106.3s, app approval91.0s, run
bac99aab-ff15-467c-aad1-5a40c5e531b5. Actual email run03a78f95 reproduced
stale step5 assistance without OTP, then refreshed step6 typed the actual OTP
and the site accepted it. App root74c2f651 followed human assistance, one
helper approval and verified sign-in. Both unchanged no_tool_failures passed;
email root had52 persisted messages and zero execution failure rows.
helpers/messages.py570-635 broadcasts TOOL_STREAM ephemerally with no DB
insert; the ERROR closure is an abandoned stream, not an executed tool failure.
The exact stale model decision remains in its preserved LLM dump.

Native benchmark and local-stack cleanup receipts both clean for final run.
The no-OTP app_approval fixture in the causal test proves ordinary assistance
retention only; genuine app-approval preservation is proven by the unchanged
canonical live task above. Local correction verified; deployment/parent source
adoption remains held. No new LLM-visible text was added. Agent control-transfer
and native input sequencing changes require parent runtime-behavior/trajectory
review before adoption, with exact11-line runtime diff. Durable evidence
publication for both final agents subsequently failed closed with
HubVisibilityError: benchmark Hub upload failed: The read operation timed out.
No durable FE/recording verification is claimed; this remote publication gate
remains outstanding before rollout approval despite verified local correction.

## Human feedback

User required first phase read-only and timely evidence, isolated worktree/DB,
no changes to live suite, original clocks, instructions or Freedom; no prompt,
timeout, assertions or task weakening. User confirmed reproduction/code scope,
then corrected pending status to native FAIL and required proof of actual poll
completion order, including completion during existing drain and protocol-valid
retained history. Parent alone routes deployment; no push or merge by RCA worker.

## Reusable lesson

Drain owned authoritative input before committing control transfer, and refresh an obsolete decision through the normal input path.


## Evidence publication follow-through

The subsequent read-only Hub diagnosis found HTTP200 registration for final
bac99aab, and authenticated run-agent views returned COMPLETED transcripts
with52/56messages matching retained local captures. Production agent-preview
404 was the documented disabled feature, not a missing terminal archive.
No re-upload or new benchmark was necessary. Canonical
publish_evidence_links.py with --run-json and --skip-hub-upload used the proved
existing registration; all FE, terminal-browser and recording checks remained
enabled. Both agent views verified in fresh browsers. Latest calls selected
across each full retained root/tree were completion_summary dumps; both rendered
self-contained HTTPS documents freshly returned200. Private artifact-root
override kept local evidence files0600. Share links last30days; dump presigned
links7days. Manifests/evidence URLs are retained in the private RCA output.

Parent actual delta-guard review reports agent-behavior PASS, prompt PASS and
trajectory-injection FAIL on handler. This supersedes the investigator's
conservative inferred gate classification. Parent reviewed snapshot
a47143f5852b1ce3fc81c56eb761e1bbfe34cd1c; end-user approval for that exact
11-line trajectory hunk is still pending and must precede root adoption/rollout.
Tests/code in isolated trees were user-authorized; parent candidate review is
not an end-user trajectory approval. No guarded runtime hunk was changed.

A separately checked-out original-source baseline ran the identical registered
causal tests: measured command2.2924s exit1 (fresh/during_drain each1 decision,
zero OTP-consuming decisions); candidate1.9927s exit0 (each2 decisions,one
receiving native OTP). Both retained ordinary empty/stale/no-OTP assistance.
Across all earlier canonical attempts:3email attempts and1app attempt; reported
billable agent cost0dollars,427224input/3137outputtokens. Infrastructure,
subscription opportunity cost and evidence-publication/storage cost unmeasured.

## 2026-10-16 recurrence at the independent handoff await

Archive searches `authentication handoff new user instruction verifier await`
and `OTP arrives during judge pending assistance` identify this case as the
same input-admission boundary and the active-browser requirement case as a
related owner. The independent handoff judge introduced a new awaited boundary
after the original pre-action drain. Input arriving during that await could
therefore supersede the decision before assistance committed. This is an
owning-boundary reproduction, not an established cause of the retained native
code-never-arrives failure.

The permanent auth-handoff-verification activity controls use the real browser
activity with deterministic inbox, instruction and judge edges. The identical
eleven-control invocation records six passes/five failures before the late-input
repair and eleven passes/zero failures afterward, with zero attempted Python
socket connections in both runs. The five failing controls cover an OTP during
the judge, a USER instruction during the judge, a USER instruction during the
final inbox poll, a durable instruction-read outage and a typed generation seal.
Logs are retained as `late-input-final-before.log` and
`late-input-final-after.log` under the private OTP contract consumer review.
Their source receipt pins patch
`86c018d45991d80857f69cdef86220dd811da9fcadd09a303e561564adb1801d`
after the separately measured OTP-context and retired-buffer prerequisites.

The repair synchronizes the existing scoped USER/schema owner before judging,
then reuses the existing bounded OTP fetch/append/acknowledgement path and strict
USER/schema synchronization after an accepted judge result. Newly admitted
input returns to ordinary planning. Instruction-read outages and typed seals
propagate; the repair does not select an identity, submit a code, increase a
timeout or manufacture a provider failure. The existing two-second drain cannot
exclude slow or cancellation-resistant producers, and arrival after the final
synchronization remains possible. These controls prove the measured checkpoints,
not an atomic exclusion of every concurrent arrival.

Full combined-source coverage and unchanged native after-repair outcomes remain
pending. Private full-domain attempts exposed additional merge and test-owner
mismatches; those attempts are retained and are not replaced by the eleven
passing controls. The user requires approval only at deployment. This recurrence
reopens the case while final proof is outstanding and leaves its earlier native
results and publication history intact.


## 2026-10-15 review-only action-accounting follow-up

The approved eleven-line native-input admission hunk could supersede an unexecuted handoff at the last action slot but continue without the existing action-budget adjustment. Actual activity controls resume at step249 with MAX_ITERATIONS250: baseline897 reaches max_iterations before consuming the newly delivered input; the private correction refunds only the unexecuted action through the existing bounded adjust_iteration_after_action policy. Exhausted250 runs no model/auth/action; repeated fresh input reaches the existing consecutive refund cap, and duplicate/stale input commits one ordinary handoff without an unbounded loop. No numeric cap, timeout, task or evaluator was changed.

Parent independently inspected Hermes agent/turn_iteration_prep.py:470-490 (bounded refund of a cancelled request with no valid item), alongside Claude src/query.ts:1506-1515 (a counterexample that counts aborted tools because its unit is a turn). Rose's established unit is actions. The analogy does not refund usage or cost. This review-only follow-up has owning offline proof; new trajectory/stop semantics still require exact source review and approval. It does not explain or repair the current minted-email, SMS or magic-link failures, and does not close the original Gmail credential ownership incident.

## 2026-10-19 recorded failure case: premature handoff (not fixed)

The drain above fixes only the stranded code. The primary failure in agent
3caf15c9 is the model's decision: step 5 (dump
`1792008253214-a116a32ac814-browser_use_step_5.json`) saw the verify page at
20:04:08.3Z ("enter the 6-digit verification code we emailed to
rose.river28.4698e3a3@mail.roselabs.ai") and called
`request_user_assistance_for_authentication` 4.8 seconds later with no
reasoning, although its system prompt contained the 60-second wait/resend
contract. The code had arrived at 20:04:08.7Z. The expected behavior for this
task is wait, type the code, sign in, zero handoffs; the same early handoff
would also fail `browser-auth-code-never-arrives` (no resend).

Its Auth Options listed the password under that address but said
`Email OTP (user's inboxes): unavailable, none connected`. The likely cause is
that the model had no evidence codes sent to that address reach it; the later
`readableInboxEmails` change marks such identifiers "codes sent here reach you
automatically". This is unverified: no replay compared the old and new Auth
Options. The user chose to record this case and not fix it now.
