---
id: 2026-08-25-guest-do-not-sign-in-blocks-cookie-commit
date: 2026-08-25
title: "do not sign in" guest goals falsely veto logged-out cookie commit
surface: browser
component: domains/spawn_browser_agent_v3/challenge_recovery.py goal_allows_logged_out_cookie_commit
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
repro: cd agents && source venv/bin/activate && python tests/blackbox/challenge_recovery.blackbox.py goal_allows_logged_out_cookie_commit
status: fixed
---

# RCA: "do not sign in" blocked guest cookie commit

## Problem

Post-payment-boundary-suffix local rerun of `browser-hotel-booking`
(`4bbd1e64`, 1131s) hit Hotels.com "Bot or Not?" after Search, then burned
~15 minutes on two challenge recoveries that both ended in
`No stable browser configuration cleared the challenge`. Cookie probes had
proven clean strips (`stablePasses=1`), but recovery took
`preserve_auth_state` instead of committing the guest strip.

## Diagnosis

`goal_allows_logged_out_cookie_commit` checked signed-in needles (`"sign in"`,
`"log in"`, …) **before** guest needles. Guest goals say `"Do not sign in"`;
the substring `"sign in"` matched and returned `False`, so
`allow_logged_out_cookie_commit` stayed off and the clean `all_target` strip
was discarded.

Local repro (pre-fix):

```bash
cd agents && source venv/bin/activate
python -c "from domains.spawn_browser_agent_v3.challenge_recovery import goal_allows_logged_out_cookie_commit as g; assert g('Use guest checkout only. Do not sign in.')"
# AssertionError
```

The existing blackbox `goal_allows_logged_out_cookie_commit` already asserted
this case and was red on main — the signed-in veto was smell that never
earned its keep (signed-in goals simply lack guest needles).

## Solution

Remove the signed-in substring veto. Guest needles alone gate the commit path;
absence of guest language keeps preserve-auth (default False).

Cemented in `test_goal_allows_logged_out_cookie_commit_for_guest_prompts`
(includes the exact 4bbd1e64 spawn-goal shape).

## Human feedback

User (2026-08-30): "the disabling of the guest cookie commit recovery path
logic sounds smelly" — agreed; veto deleted rather than patched with
negation regex.
