---
id: 2026-07-13-completion-coupled-to-sms-delivery
date: 2026-07-13
title: Completion and SMS delivery shared one tool, so a progress acknowledgement could terminate the run and completion could be silent
surface: agents
component: sms-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: SMS supervisor tool surface — one tool both sent the user message and signaled completion
symptoms:
  - agent run ends after sending a progress acknowledgement instead of finishing the task
  - a run completes without ever sending an SMS to the user
tags:
  - sms
  - attempt-completion
  - tool-contract
  - silent-completion
  - supervisor
sources:
  - PR #764
repro: none-recorded
status: fixed
---

## Problem

Two opposite failures came from the same tool contract. A message that was only a
progress acknowledgement could terminate the run, because sending it was
indistinguishable from completing. And a run could complete having never sent the
user an SMS at all — silent completion, where the user sees nothing.

## Diagnosis

Completion and delivery were coupled into one tool call, so the model had no way
to express "tell the user something and keep working" and no obligation to have
delivered anything before finishing. Any harness that fuses a side effect with a
terminal signal inherits both failure directions: premature termination when the
side effect is used for a non-terminal purpose, and an unenforced side effect when
the terminal signal is used alone. The bug is in the contract, not in the model's
choice.

## Solution

Split the surface: `send_user_message` performs delivery, and an argument-free
`attempt_completion` signals termination — with an enforced invariant that a run
cannot complete before an SMS has been sent. A completion-invariant regression test
was added to durable coverage, so neither silent completion nor
acknowledgement-as-termination can return.

## Human feedback

The same PR codified RCA local-repro and post-fix verification requirements,
making a reproduced failure plus a passing post-fix run mandatory for this class
of harness-contract defect.

## Reusable lesson

Never let one tool both perform a side effect and signal termination — separate
them and assert the required side effect as a completion precondition.
