---
id: 2026-08-22-alchemy-momence-login-blocks-guest-payment-terminal
date: 2026-08-22
title: Momence Sign-in path blocks guest checkout and stalls at auth_assistance
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: agents/providers/rose/browser_use.py authentication priority — browser LLM clicks Momence "Sign in" and enters saved-password login before guest checkout despite goal "saved guest details", then handler pauses at credential_propagation → auth_assistance
symptoms:
  - 'Expected attention kind payment_approval, observed auth_assistance'
  - 'Expected payment_approval attention request (to ignore) but none was triggered'
  - 'Clicked <button "Sign in">'
  - 'Updating saved credential state before waiting for user authentication assistance'
  - 'Selected ''Alchemy Springs'' from <select "Select your home location'
tags:
  - browser-agent
  - alchemy
  - momence
  - auth-assistance
  - payment-approval
  - guest-checkout
sources:
  - agent 9aceb675-d12c-412c-a009-d8c5a4fc4b1e
  - fleet run e2e79c51-7714-417e-95ab-2adb38ee9121
repro: agents/tests/blackbox/benchmark.blackbox.py — test_alchemy_k5_auth_assistance_terminal_fails_payment_contract
status: open
---

## Problem

Post evaluate-timeout fix, `browser-alchemy-springs-sauna` k=5 returned **3/5**.
Agent `9aceb675` failed in 188s with:

`Expected attention kind payment_approval, observed auth_assistance | Expected payment_approval attention request (to ignore) but none was triggered`

Trajectory: correct Sunday calendar selection → Momence tab → **clicked Sign in** → typed
`andyprevalsky@yahoo.com` + password → Log in → home-location dropdown →
`credential_propagation` / auth_assistance pause. No `request_payment_card`.

Task prompt says **"use my saved guest details"**; benchmark contract requires exactly
one unresolved `payment_approval` (`expected_attention_kind: payment_approval`).

## Diagnosis

**Relative** of `2026-08-21-alchemy-evaluate-recovery-error-fails-no-tool-failures` cohort B
(auth_assistance before selection) — same login-first pattern, now under payment-only terminal.

Archive searches: `auth_assistance payment_approval alchemy`, `Sign in guest checkout momence alchemy`.
Hits: evaluate-recovery case (relative, separate harness thread). **Novel boundary** for this
run: login-first on Momence when guest checkout is viable.

Critical path: browser system prompt ranks saved-password login above guest checkout
(`guest/anonymous` is priority 7). Momence booking surfaces a prominent **Sign in** button;
3/5 passing agents also clicked Sign in but recovered (password fail → guest path).
`9aceb675` entered credential propagation for home-location onboarding and stalled at
`auth_assistance` before payment.

First-bad boundary: browser LLM `click` on **Sign in** (step 31) when guest checkout was
available and goal requested saved guest details.

Offline repro (0.0s): `evaluate_task` with `attention_request_kind_seen=auth_assistance` →
`Expected payment_approval attention request but it was not observed`.

## Solution

**Proposed (not yet implemented):** Goal-aware auth routing in
`agents/providers/rose/browser_use.py` (shared browser system prompt):

- When goal text includes `guest details`, `guest checkout`, or `book as guest`, treat
  Momence-style booking flows as **guest-first**: skip Sign in, fill guest contact fields.
- Keep passkey/password priority for sites that truly gate checkout behind login.

Causal proof after fix: same `test_alchemy_k5_auth_assistance_terminal_fails_payment_contract`
remains (documents failure shape); new prompt-guidance test + k=5 fleet should stop producing
auth_assistance terminals on this task.

Outcome proof: `scripts/run-bench --local browser-alchemy-springs-sauna` ×5 with no
auth_assistance failures.

Do **not** revert terminal contract to `auth_assistance` any-of.

## Human feedback

User invoked `/rca the failures` after k=5 returned 3/5 following evaluate-timeout fix.
Prior approval: payment-card request is the correct terminal for this task.

## Reusable lesson

When a benchmark goal explicitly requests guest checkout, elevate guest/anonymous completion
above account Sign-in in the shared browser auth priority — Momence will still show Sign in.
