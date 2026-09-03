---
id: 2026-08-31-guest-recovery-prefers-known-challenge-over-all-target
date: 2026-08-31
title: Guest fresh-cookie recovery preferred weak known_challenge strip over all_target
surface: agents
component: recover_from_challenge allow_logged_out_cookie_commit / auth_cookies_are_preserved
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: challenge_recovery.recover_from_challenge committed known_challenge before all_target when both probed clean under allow_logged_out_cookie_commit
symptoms:
  - auth_cookies_are_preserved=false on recover_from_challenge
  - Applying safe cookie recovery / Recovered by removing a proven non-auth cookie subset
  - Hotels.com GraphQL HTTP 429 persists after Bot-or-Not clear
  - Expected payment_approval attention request but none was triggered
tags:
  - browser-hotel-booking
  - challenge-recovery
  - guest-checkout
  - cookie-commit
  - graphql-429
sources:
  - agent 58721c46-7b48-4d2f-97a5-7131a1ddc222
  - fleet run 20260831_001446_browser-hotel-booking
repro: cd agents && source venv/bin/activate && python tests/blackbox/challenge_recovery.blackbox.py guest_path_prefers_all_target_over_known_challenge
status: fixed
---

# RCA: Guest recovery must prefer all_target over known_challenge

## Problem

After renaming the tool param to `auth_cookies_are_preserved`, local hotel bench
agent `58721c46` correctly set `auth_cookies_are_preserved=false` and cleared
Bot-or-Not, but still timed out without `payment_approval` under persistent
Hotels.com GraphQL HTTP 429.

## Diagnosis

`recover_from_challenge` probed both `known_challenge` and `all_target` in one
wave. When both were clean and `allow_logged_out_cookie_commit` was true, the
handler committed the **weaker** known-challenge strip first and returned
`cookies_sanitized`, never applying the guest all-target clear the flag exists
for. Soft-block cookies outside the known-challenge allowlist stayed on the live
tab.

Archive: relative of `2026-08-25-guest-do-not-sign-in-blocks-cookie-commit` and
residual gap in `2026-08-21-hotels-com-classifier-network-summary-omits-http-status`.

## Solution

When `allow_logged_out_cookie_commit` is true and `all_target` probed clean,
commit all-target **before** considering known-challenge. Cemented by
`test_guest_path_prefers_all_target_over_known_challenge_when_both_clean`.

## Human feedback

User (2026-08-30): `auth_cookies_are_preserved=false` means explore fresh cookie
state (may lose auth; may clear poisoned anti-bot cookie).

## Reusable lesson

When an explicit recovery mode authorizes a broader clean state, prefer that proven state over a weaker subset that can retain the original blocker.
