---
id: 2026-08-22-browser-event-ticket-relative-date-without-clock
date: 2026-08-22
title: Root agent resolved "this Friday" to Sat Aug 22 because system prompt has no calendar clock
surface: agents
component: utils/prompts.build_system_prompt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/prompts.py build_system_prompt — never injects authoritative today/weekday/timezone for relative-date goals
symptoms:
  - "this Friday"
  - "Friday, August 22, 2026 (today is already Friday Aug 22"
  - "Sat Aug 22, 2026, 8:15pm"
  - "a Saturday approval does not satisfy the Friday criterion"
  - "movie-ticket-seat-selection-semantics"
tags:
  - browser-event-ticket
  - relative-date
  - system-prompt
  - calendar-grounding
sources:
  - agent de5e876a-5e97-4d23-831d-cfa50667c035
  - commit c7bcf0c7f120ef38550767b6454c8529e7669eea
repro: agents/tests/blackbox/prompts_calendar_grounding.blackbox.py (pending — fails until clock injected)
status: open
---

# RCA: relative "this Friday" without system-prompt calendar

## Problem

`browser-event-ticket` pass@k parallel attempt `de5e876a-…` raised payment for
**Sat Aug 22, 2026 8:15pm** while the task requires **this Friday**. Runtime
contract passed; `movie-ticket-seat-selection-semantics` failed on the date.

Root `execute_loop` (`claude-fable-5`) spawned the browser with goal text:
`Friday, August 22, 2026 (today is already Friday Aug 22 in UTC…)`. Calendar
truth: 2026-08-22 is **Saturday**; upcoming Friday is **2026-08-28**. Sibling
agents that correctly said Aug 28 passed.

## Diagnosis

Critical path: user goal `"this Friday"` → root `execute_loop` →
`spawn_browser_agent` goal date → AMC checkout → payment approval date.

Binary search: payment text is wrong → spawn goal already wrong → ASSISTANT
tool_call authored the wrong date → system prompt / context for that call has
**no** authoritative `Today is <weekday> <ISO> <tz>` line
(`build_system_prompt` only concatenates MAIN + user_context + phase).

Local repro (observed FAIL):

```bash
cd agents && source venv/bin/activate && python - <<'PY'
from datetime import datetime, timezone
import re
from utils.prompts import build_system_prompt
prompt = build_system_prompt(phase='EXECUTE', enabled_tools=['spawn_agent'])
low = prompt.lower()
assert re.search(r"today'?s date|current date|today is\b", low), prompt[:200]
PY
```

→ `AssertionError: build_system_prompt lacks authoritative today/weekday grounding`

Archive search: relative — IMAX earliest-showtime grounding case; no prior case
for missing system-prompt clock on relative weekday phrases. Novel boundary.

## Solution

Proposed (awaiting approval — prompt change): inject an authoritative
`# Current Time` section into `build_system_prompt` using workflow-safe clock
(UTC + user-local if available) with weekday + ISO date, and instruct the model
to resolve relative dates against that clock only. Cement with blackbox that
the section is always present. Then outcome-proof `scripts/run-bench --local browser-event-ticket` (k≥1).

Do **not** weaken the Friday evaluator.

## Human feedback

None recorded yet for this case file (opened during k=5 RCA).

## Reusable lesson

Never ask the agent for relative calendar language ("this Friday") without
injecting an authoritative today/weekday/timezone into the system prompt.
