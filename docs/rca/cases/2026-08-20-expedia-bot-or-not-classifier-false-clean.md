---
id: 2026-08-20-expedia-bot-or-not-classifier-false-clean
date: 2026-08-20
title: Expedia Bot or Not classifier read as clean, auth_assistance misroute
surface: agents
component: challenge-recovery
classification: our-bug
problem_class: other
first_bad_boundary: agents/domains/spawn_browser_agent_v3/challenge_recovery.py::page_looks_challenged
symptoms:
  - Expected attention kind write_lock, observed auth_assistance
  - Bot or Not?
  - Current page does not look challenged
  - skipped_clean_page
  - request_user_assistance_for_authentication
tags:
  - browser-agent
  - challenge-recovery
  - captcha
  - datadome
  - expedia
  - auth-assistance
  - hotel-booking
sources:
  - agent fead82a5-791a-43b8-b807-5e71226da866
  - plan:agents/benchmarks/runs/20260820_205039_browser-hotel-booking.json
repro: agents/tests/blackbox/challenge_recovery.blackbox.py::test_challenge_page_classifier_detects_expedia_bot_or_not
status: fixed
---

## Problem

`browser-hotel-booking` failed with `Expected attention kind write_lock,
observed auth_assistance` while the browser document title was `Bot or Not?`
and the DOM mounted `#app-captcha-pwa`. The last browser tool call was
`request_user_assistance_for_authentication`. Immediately before that,
`recover_from_challenge` returned `recovery_action: skipped_clean_page` with
message `Current page does not look challenged` on the same Expedia Hotel
Kabuki URL.

Archive searches (`write_lock auth_assistance`, `CAPTCHA Bot or Not`,
`start_url booking.com captcha`) found relatives (Expedia storage-capture hang,
DataDome vendor coverage, Steel/auth_assistance cases) but not this
false-clean → auth_assistance misroute. Novel relative of the DataDome vendor
false-clean class: captcha instruction prose cleared the substantive-content
hatch, and `Bot or Not?` / `#app-captcha-pwa` were absent from markers.

## Diagnosis

Critical path: browser state (title/DOM) → `live_tab_looks_challenged` →
`page_looks_challenged` → `recover_from_challenge` skip → model calls
`request_user_assistance_for_authentication` → evaluator sees
`auth_assistance`.

First-bad boundary: `page_looks_challenged` returned False for the Expedia
DataDome PWA interstitial. Measured local repro on the buggy classifier:

- title+body only → False
- `#app-captcha-pwa` shell → False
- `captcha-delivery.com` + long captcha instruction body → False (substantive
  hatch treated interstitial copy as a recovered page)

Why deeper: sensor-host HTML markers shared one list with interstitial
containers, so `#app-captcha-pwa` / `ddchallengebody` were subject to the
substantive-content escape meant only for leftover sensor scripts. Title
`Bot or Not?` was also missing from rendered text markers. A secondary gap:
auth assistance had no live-tab challenge guard, so a false-clean skip could
open an `auth_assistance` attention row.

Root agent `start_url` was Expedia despite `live_targets: booking.com`; that
steered into the wall but is metadata-only today and is not required to prove
the captcha→auth_assistance misroute.

## Solution

1. Add rendered text markers for Expedia/DataDome PWA copy (`bot or not`,
   `show us your human side`, …).
2. Split HTML markers into sensor hosts (still gated by substantive content)
   vs definitive interstitial containers (`app-captcha-pwa`, `ddchallengebody`,
   `px-captcha`, …).
3. Block `request_user_assistance_for_authentication` when
   `live_tab_looks_challenged` is true; steer the model via tool description +
   system prompt to use `recover_from_challenge` for CAPTCHA walls.

Sibling failures prevented: any DataDome/PerimeterX interstitial whose
instruction copy exceeds 80 chars no longer false-cleans; captcha pages can no
longer open auth_assistance attention. 10k-agent behavior: O(1) string checks
per recovery/auth call, no shared state.

## Human feedback

None recorded. Descend preferred captcha→auth_assistance misroute over
weakening write_lock; no reward hacks on the task contract.

## Reusable lesson

Treat interstitial captcha containers and rendered challenge titles as
definitive challenged signals; never let captcha instruction prose clear the
sensor-host substantive-content hatch, and never escalate a challenged page to
auth_assistance.

## Correction (2026-08-20)

`skipped_clean_page` is **not** "passed proxy rotation metrics". It was an
early handler no-op before `recover_from_challenge` ran solver → cookie probes
→ parallel Kernel/Steel browser/IP search. Fix: remove that early-exit so an
LLM-requested recover always runs the search; keep Bot or Not classifier +
auth-assistance guard as secondary defenses.
