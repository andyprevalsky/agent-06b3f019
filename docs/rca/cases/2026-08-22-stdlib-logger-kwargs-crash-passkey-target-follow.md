---
id: 2026-08-22-stdlib-logger-kwargs-crash-passkey-target-follow
date: 2026-08-22
title: stdlib logging.info kwargs in passkey target-follow crash switch_tab / kill browser agent
surface: agents
component: browser-tools-dom-service-passkeys
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/dom_service.py::_follow_focused_passkey_target — logger.info(..., previous_target_id=, target_id=) on stdlib logging.Logger
symptoms:
  - "Logger._log() got an unexpected keyword argument 'previous_target_id'"
  - "Failed during: switch_tab"
  - "Tool 'spawn_browser_agent' exceeded its exact root call limit during execution: expected 1, got 2"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "recorded 0 trajectory step(s); expected at least 5 per browser agent"
tags:
  - passkey
  - switch-tab
  - stdlib-logging
  - typeerror
  - spawn-browser-agent
  - alchemy-springs
sources:
  - agent 676d6ed9-c8ec-4700-9fe8-dc64419ebb96
  - commit 4af8a910b2b92a8ede78953d0ad082c56a0372bc
  - fleet run 20260822_022651_browser-alchemy-springs-sauna
repro: none-recorded
status: open
---

## Problem

Alchemy k=5 attempt `676d6ed9-c8ec-4700-9fe8-dc64419ebb96` failed after the first
`spawn_browser_agent` died mid-booking with
`TypeError: Logger._log() got an unexpected keyword argument 'previous_target_id'`
attributed to `switch_tab`. The root agent then ran
`credential_failure_classifier` → explore (`spawn_agent` + web_search/fetch) →
a second `spawn_browser_agent` (0 trajectory steps), so static checks failed on
`spawn_browser_agent` expected 1 got 2, missing `payment_approval`, and empty
second-browser trajectory. FE:
https://roselabs.ai/?agent-id=676d6ed9-c8ec-4700-9fe8-dc64419ebb96

## Diagnosis

Archive searches (`previous_target_id`, `unexpected keyword argument` Logger,
`switch_tab` TypeError) found no matching prior case — novel instance; relative
only to other double-browser / tool-count failures with different causes.

Critical path:

1. Browser #1 reached Momence / multi-tab state and called `switch_tab`.
2. Passkey rebind path ran `_follow_focused_passkey_target` (via
   `inject_passkeys` / realm sync after focus/target change).
3. That helper logs with structlog-style kwargs on a **stdlib**
   `logging.getLogger(__name__)` logger introduced in
   `4af8a910b` ("durable multi-account compute connections").
4. With INFO enabled, `Logger._log()` raises TypeError on `previous_target_id`.
5. Browser agent fails → classifier + explore + second browser → tool-count fail.

Local owning-boundary repro (same TypeError string as prod):

```bash
python3 - <<'PY'
import logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("browser_tools.dom_service")
logger.setLevel(logging.INFO)
logger.info(
    "🔑 [passkey] following focused browser target",
    previous_target_id="OLD",
    target_id="NEW",
)
PY
```

Measured failure: `TypeError: Logger._log() got an unexpected keyword argument 'previous_target_id'` (wall ~0.07s).

## Solution

Pending approval. Proposed generalizable fix: format the stdlib log line with an
f-string / `%s` args (matching the rest of `dom_service.py`), and cement a
blackbox that enables INFO and asserts `_follow_focused_passkey_target` /
target-rebind logging does not raise. Do not relax
`browser_agent_session_count` or tolerate the second spawn — fix the crash that
forces the cascade. 10k-agent behavior: O(1) per passkey target rebind (string
format only); no new fan-in, queries, or broadcasts.

## Human feedback

None recorded.

## Reusable lesson

Never pass structlog-style keyword fields into stdlib `logging.Logger` methods —
they TypeError under INFO/DEBUG and can kill the browser agent mid-action.
