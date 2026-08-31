---
id: 2026-08-25-guest-do-not-sign-in-blocks-cookie-commit
date: 2026-08-25
title: Guest cookie-commit gated by tool param, not goal sniffing
surface: browser
component: recover_from_challenge auth_cookies_are_preserved tool param
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: goal_allows_logged_out_cookie_commit signed-in substring veto matched inside "do not sign in" before guest needles ran, forcing preserve_auth config search on hotels.com guest checkout
symptoms:
  - "Preserving auth; searching configs"
  - "A cookie variant looked clean in isolation, but unknown cookies are preserved"
  - "No stable browser configuration cleared the challenge"
  - "Browser challenge recovery failed" / "Unknown error"
  - goal_allows_logged_out_cookie_commit("…do not sign in…") == False
tags:
  - browser-hotel-booking
  - challenge-recovery
  - guest-checkout
  - cookie-commit
  - substring-false-positive
sources:
  - agent 4bbd1e64-f570-4c40-8167-9f72ccafb217
  - fleet/local run 20260825_185100_browser-hotel-booking
repro: cd agents && source venv/bin/activate && python tests/blackbox/rose_browser_use.blackbox.py recover_from_challenge_auth_cookies_are_preserved_flag
status: fixed
---

# RCA: Guest cookie commit is a tool param

## Problem

Post-payment-boundary-suffix local rerun of `browser-hotel-booking`
(`4bbd1e64`, 1131s) hit Hotels.com "Bot or Not?" after Search, then burned
~15 minutes on two challenge recoveries that both ended in
`No stable browser configuration cleared the challenge`. Cookie probes had
proven clean strips (`stablePasses=1`), but recovery took
`preserve_auth_state` instead of committing the guest strip.

## Diagnosis

`goal_allows_logged_out_cookie_commit` sniffed goal text for guest vs signed-in
language. A signed-in substring veto (`"sign in"`) matched inside
`"Do not sign in"` and returned `False`, so guest commit stayed off.

User feedback: goal sniffing is smell — the acting agent should set the flag
on the `recover_from_challenge` tool call. Param should be framed as
`auth_cookies_are_preserved` (true = keep logged-in state on the new machine;
false = explore fresh cookie state, may lose auth but can clear a poisoned
cookie forcing anti-bot).

## Solution

1. Delete `goal_allows_logged_out_cookie_commit`.
2. Add optional `auth_cookies_are_preserved` bool on `recover_from_challenge`
   (default true). Handler maps `allow_logged_out_cookie_commit = not
   auth_cookies_are_preserved`.
3. Provider-exit synthetic recovery keeps the default (preserve auth).

Cemented in `test_recover_from_challenge_normalizes_auth_cookies_are_preserved_flag`
and `test_guest_path_commits_clean_all_target_strip`.

## Human feedback

User (2026-08-30): "the disabling of the guest cookie commit recovery path
logic sounds smelly"

User (2026-08-30): "can we just completely disable it, and instead let the
flag be set as a param in tool call for recover from captcha?"

User (2026-08-30): param should mean auth_cookies_are_preserved — true when
logged in and the new machine must keep auth; false to explore fresh cookies
(may lose auth, may fix poisoned anti-bot cookie).

## Outcome follow-up (2026-08-31)

Local `scripts/run-bench --local browser-hotel-booking` on
`auth_cookies_are_preserved` rename (agent
`58721c46-7b48-4d2f-97a5-7131a1ddc222`, run
`20260831_001446_browser-hotel-booking`): model set
`auth_cookies_are_preserved=false` on all four `recover_from_challenge` calls;
first recovery cleared Bot-or-Not via cookie strip and reached Hotel Kabuki
property/room UI. Still **FAIL** timeout 1139s with no `payment_approval` —
residual Hotels.com GraphQL HTTP 429 soft-block (same outcome gap as
`2026-08-21-hotels-com-classifier-network-summary-omits-http-status` follow-up).
Durable FE: https://www.roselabs.ai/?agent-id=58721c46-7b48-4d2f-97a5-7131a1ddc222
