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

## Problem

After renaming the tool param to `auth_cookies_are_preserved`, local hotel bench
agent `58721c46` correctly set `auth_cookies_are_preserved=false` and cleared
Bot-or-Not, but still timed out without `payment_approval` under persistent
Hotels.com GraphQL HTTP 429.

## Diagnosis

`recover_from_challenge` probed both `known_challenge` and `all_target` in one
wave. When both were clean and `allow_logged_out_cookie_commit` was true, the
commit order preferred the weaker `known_challenge` strip, leaving cookies that
still tripped GraphQL 429.

## Solution

When `allow_logged_out_cookie_commit` is true and both probes are clean, prefer
`all_target` over `known_challenge` so guest recovery commits the stronger strip.

## Human feedback

Follow-up from the 2026-08-25 guest cookie-commit RCA: param rename alone did
not clear Hotels.com GraphQL 429; commit-order preference still mattered.

## Reusable lesson

Guest cookie recovery must prefer the strongest clean strip (`all_target`) over
a weaker known-challenge subset when both pass, or soft blocks persist after the
visible challenge clears.
