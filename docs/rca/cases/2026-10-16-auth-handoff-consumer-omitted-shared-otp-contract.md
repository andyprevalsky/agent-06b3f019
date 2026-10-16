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
