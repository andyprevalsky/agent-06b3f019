---
id: 2026-10-27-canvas-task-conflicts-with-browser-challenge-policy
date: 2026-10-27
title: Canvas CAPTCHA task conflicts with the browser actor's no-solving policy
surface: agents
component: browser-authentication-contract
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: captured browser actor system contract prohibits solving the challenge requested by polar-bu-002; causal intervention unproven
symptoms:
  - polar-bu-002 r1
  - polar perfect-score failed (1/3 rubrics)
  - I cannot complete CAPTCHA verification on your behalf
  - task_completed=false
tags:
  - polar
  - browser-prompt
  - captcha
sources:
  - agent a1c2ef72-a3c0-4648-9729-cb373877e3e1
  - fleet run campaign-20261027-060019-631588
  - commit 35ae7f4a7e15dda8a41d093f3d778a5722c0e5c1
  - commit 0c96ea5a86edf9f3267e6a4edacf4870cf834bd0
repro: none-recorded
status: open
---

## Problem

The exact task asks: Go to the URL and read the text from the canvas CAPTCHA
and enter it to complete the task.
https://browser-use.github.io/stress-tests/challenges/canvas-captcha.html

Campaign A r1 received 1/3: C1 and C2 fail, C3 passes. Its final structured
response reports CAPTCHA123 and task_completed=false. The captured browser
trajectory has no input_text or submission action. The judge's noncompletion
verdict is supported by that trajectory, despite the root's COMPLETED lifecycle.
Original compressed run SHA256:
2a82f83aea1d15a68f701487ffa737a79e438a7be773e7a63c6de2b6081abea6.

## Diagnosis

Path: task -> child browser goal -> authentication/system/tool contract ->
actor decision -> no submission -> truthful false completion output -> C1/C2 fail.
The captured first browser call (`browser_use_step_1`, dump 75c70982fbca)
contains an indexed text input, the user request to enter the CAPTCHA, and a
system instruction forbidding the actor to solve challenge widgets itself.
The actor selects recover_from_challenge with the reason that the task explicitly
requires CAPTCHA transcription and no alternate path can complete it.
A later captured call (`browser_use_step_4`, dump a71696c5c2a8) returns:
"I couldn’t submit the form or verify a result. The page remains on the CAPTCHA
challenge with the input empty. I can’t complete CAPTCHA verification on your behalf."

The source of that policy is agents/utils/browser_auth_contract.py and matching
screenshot/recovery tool descriptions in agents/providers/rose/browser_use.py.
Existing blackbox tests explicitly assert the no-solving directive. Thus this
is a concrete instruction conflict, not evidence of an underspecified task.
Causal model intervention has not been run; this remains preliminary findings
with an open reproduction gap, not a completed model-intelligence RCA.

Siblings do not establish mere stochasticity: r2 succeeded only via a later
code-agent Playwright fallback, while r3's original browser also did not submit
and its later code-agent success suffered a separate evaluator truncation bug.
See 2026-10-27-polar-judge-truncates-code-tool-evidence. A pass on an alternate
path does not prove a task-definition flaw or repair the browser path.

Archive searches: `polar-bu-002 canvas captcha` and
`polar judge trajectory screenshots failure`. No exact-task case was found;
the CAPTCHA recovery and evaluator-evidence cases are relatives, not proven
recurrences. All three exact catalog objects match original source and current
0c96ea5a8 (canonical JSON SHA256
c4209f7fac08901aaec68bc4965b7576fa8592f20d9308dfe93f50e720ae1618).

## Solution

No task, prompt, policy, or runtime change proposed or applied. Independent
task-definition review was requested by the parent. Reviewer ph7dr4b0p5nc2qjtnfhtgsqpmx8h2zq6 independently returned UNPROVEN
for a task-definition defect: the task and rubric are coherent, r1 is an
acting-prompt conflict, and r3 is an evidence transport issue. The investigation must
retain the original task and require strong reference grounding before any
policy candidate. Removing the deliberate policy just to improve this task's
score would not establish a generalizable, authorized repair.

Missing proof: identical local actor-call failure/green intervention with all
non-candidate parameters fixed, plus unchanged task outcome proof. No paid
cloud benchmark or deployment was launched by this investigator.

## Human feedback

The user prohibited task edits and required independent cross-review proving
any claimed definition flaw, not pass-rate variation. The parent expanded the
scope to r3 and required the no-browser cluster to remain separate.

## Reusable lesson

Compare the captured actor policy with the exact task before attributing a truthful noncompletion verdict to model randomness or a faulty task definition.
