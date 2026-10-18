---
id: 2026-10-18-handoff-verifier-score-meaning-undefined
date: 2026-10-18
title: The auth handoff verifier returned score 1.0 while concluding the handoff was not justified, because its goal never defined the score
surface: agents
component: browser-auth-handoff-verification
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AUTH_HANDOFF_VERIFICATION_GOAL (agents/domains/spawn_browser_agent_v3/handoff_verification.py) asks "verify whether transferring is justified" but never says what score means, while handler.py admits the handoff only on score == 1.0
symptoms:
  - browser-auth-minted-sms-otp tree stalled with the browser agent waiting for user authentication assistance
  - verifier_browser_auth_handoff reasoning says "The handoff is not justified yet" with score 1.0
  - browser agent paused for an SMS code that never arrives although the minted phone was never tried
tags:
  - auth
  - handoff
  - verifier
  - score-contract
  - sms-otp
sources:
  - agent 3933c49a-653b-4380-a963-bf250659f695
  - agent 618d6f12-4afa-4892-878c-392f10a43c13
repro: agents/tests/blackbox/auth_handoff_verification.blackbox.py
status: fixed
---

## Problem

`browser-auth-minted-sms-otp` failed in the cdf0aed full-30 run (agent
3933c49a, tree stalled 516s, PAUSED). The browser agent submitted the user's
phone, the site answered `unknown_account` and sent no code, and the agent
called `request_user_assistance_for_authentication`. The independent handoff
verifier wrote "The handoff is not justified yet ... no declared branch supports
transferring control now" and returned `score: 1.0`. `handler.py` admits a
handoff exactly when `score == 1.0`, so the browser task paused for a code that
could never arrive instead of continuing with the listed minted phone.

## Diagnosis

The verifier runs under the generic judge rubric, where 1.0 means "every
required field is populatable from grounded evidence". The per-call goal
`AUTH_HANDOFF_VERIFICATION_GOAL` asks the judge to *verify whether* the transfer
is justified but never binds the score to that decision. A complete, grounded
analysis that concludes "not justified" therefore satisfies the rubric's 1.0
reading, and the gate reads it as approval. Passing runs of the same task got
0.5 with the same conclusion; the outcome depended on which reading the model
chose.

Replays of the two dumps whose reasoning contradicted their score (`--mode exact`,
unchanged messages; candidate adds only the score sentence):

| dump | baseline approvals | candidate approvals |
| --- | --- | --- |
| 3933c49a (SMS OTP) | 1/10, reasoning "not justified" | 0/10 |
| 618d6f12 (email code) | 3/10, reasoning "not justified" | 0/10 |
| justified controls: options exhausted, account locked, app approval | 1.0 originally | 12/12 |

Every baseline approval contradicted its own reasoning; the candidate's scores
matched its reasoning in all 32 replays. The earlier Auth Options phone label
(`6f53a9a42`) was reverted: baseline runs without it also passed, and the
divergence is at the verifier, not the actor's identity choice.

## Solution

`AUTH_HANDOFF_VERIFICATION_GOAL` now ends with "The score is this handoff
decision: 1.0 only when the transfer is justified now; otherwise 0.0." The
existing `auth-handoff-verification` blackbox asserts that sentence reaches the
per-call directive and both provider request bodies (fails on the old source).

At 10k agents: one sentence (~20 tokens) per handoff verification call; no new
calls, channels, or state.

## Human feedback

The user deferred prompt approval to the deploy step: fix failures, rerun every
unchanged auth benchmark, then request approval with the exact diff.

## Reusable lesson

When a gate consumes a judge's numeric score as a decision, the per-call goal
must state what each score value decides. A generic completeness rubric lets a
well-grounded "no" score 1.0.
