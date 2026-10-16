---
id: 2026-10-16-auth-handoff-consumer-omitted-shared-otp-contract
date: 2026-10-16
title: Independent auth handoff consumer omitted the existing OTP exhaustion contract
surface: agents
component: browser-handoff-verification
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: handoff verifier context lacked the planner-owned OTP delivery and bounded exhaustion rule; native outcome causality remains unproved
symptoms:
  - browser-auth-code-never-arrives FAILED after the original 900 second deadline with no attention request
  - all nine actual handoff judgments returned score 0.5 while omitting the existing OTP paragraph
tags:
  - authentication
  - verifier-context
  - shared-contract
  - otp
sources:
  - commit f0fe35fbb9ccbbb426fdbc49d46b36d0454c26f2
  - agent efef6c7e-3bf0-4447-bb43-e578b9c94390
  - benchmark run 0d05e7c4-df68-4ef3-bb48-f4c8d9b07be7
  - commit b6b2773fe2d7c045d3963410643f4d6a83125017
repro: agents/tests/blackbox/auth_handoff_verification.blackbox.py
status: open
---

## Problem

The unchanged native no-code task failed at 918.0 seconds including fixture/orchestration; the original execution deadline remained 900 seconds and its evaluator found no expected auth assistance attention request. Its earlier b547 comparator passed the exact same canonical task definition. All nine retained real Sol handoff judgments returned 0.5. Their input contexts omitted the planner's existing rule: no received OTP after 60 seconds permits resend, then another 60 seconds without a received code exhausts that route. The first three packets retained the actual 15+45 second waits, resend, and subsequent 60 second wait, so later last-30-history truncation cannot explain those first rejections. Judgments instead required verified delivery failure. Successful waits do not prove provider failure, mailbox health or registration; no such inference is made.

## Diagnosis

The observed first representation gap is build_auth_handoff_verifier_context. Its new independent consumer receives the inventory, proposal and browser observations but not the existing operational stopping contract embedded only in the planner prompt. The local owning consistency assertion fails on the original builder and passes when both consumers import one immutable source. This proves omitted input semantics and their restoration; it does not prove which actual judge decision will change or establish the native task's repaired outcome. The original failure and all nine judgments are immutable, and the case remains OPEN until unchanged native verification succeeds.

C is a missing OTP exhaustion clause at one consumer. C+1 is authoritative operational contract consistency across planner and adjudicator consumers. That general sharing approach is coherent and selected: extract the existing rule, preserve its bytes, and supply it to both owners. A still broader all-tool/all-judge contract framework remains coherent but lacks an observed owning population/reproduction justifying its implementation here; no fabricated failed coherence rung, completed Step5b, or universal class elimination is claimed. Searches for no-code resend handoff and planner/verifier contract consistency found relative contract-consumer cases, not proven same-cause recurrence. Existing shared VERIFICATION_RULES and source-owned descriptions in Claude Code, Codex, OpenClaw and Hermes support single-source contract composition; none provides Rose's exact independent auth judge.

## Solution

Private primary patch 63c877cf406135435b073c2bdeba63bdcf1a3ac6e46376b79aebc60524661bdb extracts the EXACT existing paragraph into utils.browser_auth_contract and supplies it to the planner and handoff builder. Six complete planner output variants are byte-identical, and independent AST folding proves symbolic function parity after constant substitution. The same new actual-builder assertion changes FAIL to PASS. Six existing owning cases pass with no network after a separately disclosed one-line b6 cleanup prerequisite. Restriction scenarios preserve context/inventory/proposals; they do not prove semantic judge verdicts. No identity choice, registration assertion, provider-health premise, task, timeout, evaluator or model is changed.

All nine original dump hashes are bound. Offline counterfactuals differ only by the final message's shared-policy prefix; hashes cover the four-field model/messages/config/response_format JSON envelope using sorted keys, not full HTTP wire. No model replay was dispatched. Exact changed judge output and unchanged native task outcome remain pending. The unrelated b6 undefined cleanup buffer is not a cause of the native f0 failure.

## Human feedback

The user instructed agents to fix failures, avoid overfitting and prove new passing behavior, and ask for approval only at actual deployment. No benchmark criteria or deadline override was granted.

## Reusable lesson

Share authoritative operational stopping semantics with every decision consumer instead of making an independent verifier infer a contract it never received.

## Superseding recurrence: complete Authentication policy sharing (2026-10-16)

The original no-code failure above remains native FAIL at 918.0 seconds, with its original 900-second deadline and all nine actual 0.5 judgments retained. The separate original all-options assistance task also failed at 1216.2 seconds including fixture/orchestration (1200-second task deadline; native timeout after 1201 seconds). That recurrence does not establish the same first bad boundary or erase the independent observed-evidence transport gap. Neither outcome is relabeled by the following local transport proof.

A later retained human-sign-in task, root e712b005-913b-418b-b73f-a63af94baf14 on the original f0 runtime, produced native FAIL at 920.8 seconds including fixture/orchestration, with the unchanged 900-second task deadline and native timeout after 901 seconds. Sixteen completed handoff judgments scored 0.5, from 20:51:30.992 through 21:03:58.672 UTC. Its final browser step 66 proposed assistance at 21:04:18.335 UTC; no completed judgment for that proposal is present in the retained 103-dump set. The terminal reason includes PAUSED rather than the expected COMPLETED status. That generic status check does not establish whether an attention request reached the harness, whether assistance arrived late, or whether a user-resume event occurred: this auto-approve task does not use the ignore-mode missing-attention assertion. Those phase boundaries remain an explicit evidence gap, not a claim that assistance never happened.

The observed actor/judge asymmetry extends beyond the OTP paragraph. The actor's existing complete Authentication section requires the cheapest viable path, orders existing sessions/passkeys/passwords/email/SMS/guest/minted-account routes, and permits assistance when routes 1–7 are exhausted or unavailable. Its existing handoff rule keeps the current sign-in or verification step visible and requests user-only action promptly. It does not universally require positive site-registration proof before transferring the live view. The judge correctly treats a generic code page as insufficient proof of registration, yet retained reasoning uses missing registration/required-route evidence to reject handoff while acknowledging unavailable runtime automation. That is not sufficient to assign universal-registration wording as the sole cause: the same judgments also dispute observed saved-password failures and the necessary account-access path. Unknown registration remains unknown; named-account restrictions and actual observed account claims remain evidence-bound.

Private candidate patch SHA-256 d8416e9297f8a6efa525bf45d124e8f31c91b95184b2d123b235a46bde37fff1, pinned to 598f2f196d5cc9c144dcdeacd38afffc05d0c7a5, supersedes the paragraph-only extraction as the proposed transport scope. It places the entire existing Authentication block, handoff rule and challenge variants in one pure source. The actor and independent judge compose that same verbatim policy through the same existing action-availability and challenge-disable semantics. The independent handoff verification target is unchanged. No new policy sentence, registration premise, identity directive, forced assistance, oracle, evaluator, task or deadline is introduced. The candidate remains private and unadopted in this evidence packet.

The registered actual-builder assertion in the same canonical auth-handoff-verification domain fails before the candidate (14 passed / 1 failed; 11.62 seconds) and passes afterward (15 passed / 0 failed; 10.89 seconds). All original assertion ASTs and multiplicities are preserved. Complete actor prompt output is byte-identical across 24 action/flag variants, including challenge availability and disable controls; a deliberate shared-policy mutation is rejected by comparison with the immutable original actor. Both corrected owning runs record zero denied Python socket attempts and zero completed Python socket connections. The initial inconsistent action-list fixture attempt and its failure remain retained separately. Existing named-account, app-approval, locked-account, unreadable-channel, admission, freshness and ordinary-budget controls remain present; their scripted reviewer results establish mechanism, not real-model judgment quality.

This full-policy composition adds 3162 or 3177 ASCII characters to the judge policy prefix depending on the existing challenge variant. Those are measured context character/byte deltas, not billed tokens or invoice cost. No model, site, inbox, database or native replay was dispatched for this candidate. Exact patch, complete source/changed-file hashes, before/after logs, network-denial receipts, parity controls and native chronology are retained under .context/auth-deploy/repair-final-598f2/shared-auth-policy/.

C+1 remains coherent as sharing the complete authoritative operation policy across independent decision consumers, now with the full relevant Authentication contract rather than only one stopping paragraph. This is transport consistency proof; it does not prove changed semantic verdicts, a repaired native outcome, completed Step5b, a fabricated failed ladder rung, or elimination of the entire authentication failure class. The separate observation-receipt producer/consumer gap and attention/USER-resume chronology still require their own evidence. New native after-results are UNPROVEN. This case remains OPEN; earlier findings, failures, clocks and uncertainty are preserved.
