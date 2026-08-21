---
id: 2026-08-21-hotels-com-diagnostic-clean-strip-discarded-for-auth
date: 2026-08-21
title: hotels.com challenge recovery discarded a clean cookie strip to preserve auth
surface: agents
component: challenge-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/challenge_recovery.py — diagnostic_clean path emits preserve_auth_state and never commits the proven-clean strip
symptoms:
  - 'A cookie variant looked clean in isolation, but unknown cookies are preserved; continuing with browser/IP search.'
  - 'No stable browser configuration cleared the challenge'
  - 'browser_challenge_recovery_failed'
  - 'Expected payment_approval attention request (to ignore) but none was triggered'
  - 'Refusing to leave pinned page host ''www.google.com'''
  - 'google.com/sorry/index'
  - browser-hotel-booking Timeout after 904s
tags:
  - browser-agent
  - challenge-recovery
  - hotels.com
  - guest-checkout
  - antibot
  - payment_approval
sources:
  - agent 42cc9eb7-bca7-4d87-8373-faadcd33f8ef
  - agents/benchmarks/runs/20260821_170244_browser-hotel-booking.json
  - commit e347a232e
repro: scripts/run-bench --local browser-hotel-booking
status: open
---

## Problem

Retargeted `browser-hotel-booking` (hotels.com guest checkout → unresolved
`payment_approval`) timed out at 904s on agent
`42cc9eb7-bca7-4d87-8373-faadcd33f8ef` (run
`agents/benchmarks/runs/20260821_170244_browser-hotel-booking.json`) with
`Expected payment_approval attention request (to ignore) but none was triggered`.

Runtime evidence:

- Homepage + search form worked: typed Hotel Kabuki, set Sat Aug 22–Sun Aug 23,
  reduced adults to 1, clicked Search (messages 12–32).
- Immediately after Search: challenge recovery wave (messages 33–38).
- Progress text at message 36: **“A cookie variant looked clean in isolation,
  but unknown cookies are preserved; continuing with browser/IP search.”**
- Then `browser_challenge_recovery_failed` /
  `No stable browser configuration cleared the challenge` (5× total).
- Agent escaped to `google.com` site: search; host-pin trapped it on
  `google.com/sorry` (unusual-traffic reCAPTCHA).
- Verifier (50%): “No guest-checkout or payment-card page was reached.”
- Approvals triggered: 0.

## Diagnosis

Critical path:
`spawn_browser_agent` → hotels.com Search → challenge →
`recover_from_challenge` cookie probe wave → **diagnostic_clean=True** →
`preserve_auth_state` (no commit) → `search_configs` with full auth-bearing
state → exhaust configs → model navigates to Google → host pin on `/sorry` →
timeout without `request_payment_card`.

Archive searches (`browser_challenge_recovery_failed hotels.com CAPTCHA`,
`Expected payment_approval…none was triggered`, `hotels.com guest checkout
timeout antibot`, `Refusing to leave pinned page host google.com sorry`):
**relative** of Eventim Cloudflare recovery exhaustion
(`2026-08-05-eventim-cloudflare-recovery-exhaustion-false-stable`) and Expedia
Bot-or-Not classifier case (`2026-08-20-expedia-bot-or-not-classifier-false-clean`),
not a recurrence of the booking.com free-cancel guest-skip case.

First-bad boundary: in
`agents/domains/spawn_browser_agent_v3/challenge_recovery.py`, when any of
`all_target` / `diagnostic` / half probes report clean, the code **refuses to
commit** those removals (auth-safety policy cemented by
`test_unknown_cookie_wave_probes_in_parallel_without_ddmin` /
`test_opaque_auth_cookie_that_looks_like_poison_is_never_committed`) and
escalates with preserved cookies. On this guest-checkout trajectory that
discarded the only proven-clean strip, then failed every preserved-auth
config search.

Secondary compounder (not first-bad): after recovery failure the browser LLM
left hotels.com for Google and the host-pin locked it on `/sorry`, burning the
remaining budget.

Why deeper: guest payment-boundary tasks inject `live_cookie_domains:
["hotels.com"]` credentials at session start, then challenge recovery treats
any clean logged-out probe as “dangerous auth wipe” rather than the intended
guest path.

## Solution

Proposed (needs approval — not implemented):

1. Owning-boundary: when a probe that strips **all target cookies** (`all_target`)
   is clean, attempt `commit_cookie_removals` + dual live re-verify (same as
   `known_challenge`), because isolation already proved the page clears without
   those cookies — including auth. Gate or prefer this for guest-capable /
   payment-boundary flows so signed-in checkouts keep today’s preserve-auth
   behavior.
2. Cement with a blackbox that fails on today’s preserve-only path when
   `all_target` is clean and guest recovery is requested, and passes after the
   commit path.
3. Outcome proof: unchanged `scripts/run-bench --local browser-hotel-booking`
   must reach unresolved `payment_approval` on hotels.com guest checkout.

10k-agent behavior: still one recovery wave per challenged session; commit path
is O(1) cookie mutations + two live probes, not O(agents).

## Human feedback

User corrected the bench contract: success is guest checkout → payment
credentials request (`payment_approval`), not a completed reservation /
write-lock confirmation. User pinned hotels.com and required `/RCA` if the
run did not guest-checkout.

## Reusable lesson

When a challenge cookie probe reports clean for an all-target / logged-out
strip on a guest checkout path, commit and re-verify that strip — do not discard
it solely to preserve auth and then fail config search.
