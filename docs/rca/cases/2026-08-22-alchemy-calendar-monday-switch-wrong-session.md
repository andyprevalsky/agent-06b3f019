---
id: 2026-08-22-alchemy-calendar-monday-switch-wrong-session
date: 2026-08-22
title: Calendar Mon-24 switch after Sun-23 books Monday Night session
surface: agents
component: spawn-browser-agent-v3
classification: model-intelligence-limitation
problem_class: model-intelligence-limitation
first_bad_boundary: browser agent click sequence — clicked <button "Mon\n24"> after Sun 23 and before Book now, opening momence.com/.../Monday-Night-Sauna-Garden/13681601
symptoms:
  - 'Declared evaluator alchemy-sauna-selection-semantics failed'
  - 'Monday Night Sauna Garden, Mon August 24, 2026, 5:00 PM PDT'
  - 'momence.com/Alchemy-Sauna-Garden/Monday-Night-Sauna-Garden/136816016'
  - 'Clicked <button "Mon\n24\n• •">'
tags:
  - browser-agent
  - alchemy
  - momence
  - selection-semantics
  - calendar
sources:
  - agent 8ef2cae5-9b8b-4cfd-b567-f411047d773c
  - fleet run e2e79c51-7714-417e-95ab-2adb38ee9121
repro: agents/tests/blackbox/benchmark.blackbox.py — test_alchemy_k5_monday_calendar_switch_visible_in_failure_trajectory; test_alchemy_k5_monday_night_receipt_fails_selection_semantics
status: open
---

## Problem

Post evaluate-timeout fix, `browser-alchemy-springs-sauna` k=5 returned **3/5**.
Agent `8ef2cae5` reached `payment_approval` ($50.65) but failed
`alchemy-sauna-selection-semantics`:

> Monday Night Sauna Garden, Mon August 24, 2026 at 5:00 PM PDT — not Morning Sauna Sundays
> this Sunday 10:00 AM–2:00 PM.

Runtime contract / terminal semantics passed; only selection judge failed.

## Diagnosis

Archive searches: `alchemy-sauna-selection-semantics Monday Night`, `wrong day Monday Night Sauna`.
Hits: evaluate-recovery case (tangential). **Novel** for this k=5: wrong session despite reaching payment.

Click sequence (failure vs pass):

| Agent | Calendar clicks before Book now | Result |
|-------|----------------------------------|--------|
| `8ef2cae5` FAIL | Sun 23 → **Mon 24** → Book now | Monday Night 5pm |
| `6dc8883c` PASS | Mon 24 → **Sun 23** → Book now | Morning Sauna Sun 10am |
| `b3293f04` PASS | Sun 23 only → Book now | Morning Sauna Sun 10am |

First-bad boundary: **Mon 24 click after Sun 23** (step 20–21) before Book now. Supervisor
recovery URL during waiver evaluate:
`https://momence.com/Alchemy-Sauna-Garden/Monday-Night-Sauna-Garden/13681601`.

Contributing noise: root `spawn_agent` goal sometimes labels Aug 24 as "Sunday" (Aug 24 2026 is
Monday), but passing agents `b3293f04`/`6dc8883c` had the same mislabel and still booked
Morning Sauna Sundays — decisive error is late calendar switch, not spawn date text alone.

Local repro:

1. `test_alchemy_k5_monday_calendar_switch_visible_in_failure_trajectory` (0.0s) — asserts
   Sun→Mon→Book order in archived run JSON.
2. `test_alchemy_k5_monday_night_receipt_fails_selection_semantics` (~4s) — replays
   `alchemy-sauna-selection-semantics` LLM judge on archived messages + receipt → score 0.0,
   reasoning cites Monday Night vs Morning Sauna Sundays.

## Solution

**Proposed (not yet implemented):** Browser prompt guardrails in shared auth/booking guidance:

- After selecting target Sunday on Alchemy/Momence calendar, **do not click adjacent weekdays**
  before Book now; re-verify weekday label matches goal Sunday.
- Before `request_payment_card`, confirm Momence product URL slug contains
  `Morning-Sauna-Sundays` (or equivalent Sunday session) — if `Monday-Night` or time outside
  10:00–14:00, navigate back and reselect.

Optional harness-side: static pre-payment check that flags `Monday-Night` slug when task
requires Sunday Morning Sauna (supporting signal only — outcome still judged by semantic eval).

Do **not** weaken `alchemy-sauna-selection-semantics` judge or accept Monday Night as pass.

Outcome proof after fix: same repro judge returns 1.0 on fixed trajectories; k=5 fleet pass.

## Human feedback

User invoked `/rca the failures` after evaluate-timeout fix improved k=5 from 4/5 (330s evaluate
burn) to 3/5 (different failure modes). Do not raise timeouts or relax selection criteria.

## Reusable lesson

On Momence calendar widgets, the last weekday chip clicked before "Book now" wins — verify the
Momence product URL slug matches the goal Sunday session before requesting payment.
