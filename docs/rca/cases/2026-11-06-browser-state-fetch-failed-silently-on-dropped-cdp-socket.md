---
id: 2026-11-06-browser-state-fetch-failed-silently-on-dropped-cdp-socket
date: 2026-11-06
title: Browser state fetch failed with a bare ValueError when the CDP socket dropped and no reconnect was running
surface: agents
component: agents/browser_tools/dom_service.py DOMService state fetch over browser-use
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser_tools/dom_service.py get_browser_state — called browser-use get_browser_state_summary with no handling of a dead CDP socket, so browser-use's silent handler skip surfaced as an unrecoverable ValueError
symptoms:
  - "ValueError: Expected at least one handler to return a non-None result, but none did! BrowserStateRequestEvent"
  - "browser_url_error:ValueError:Expected at least one handler to return a non-None result"
  - "Declared evaluator new-user-payment-ordered-contract failed: Observed browser agent failure: spawn_browser_agent status=ERROR"
  - "8 Browser supervisor recovery messages within 0.5s then Task Failed"
tags:
  - browser-use
  - tilion
  - cdp
  - reconnect
  - agent-payment-new-user-journey
sources:
  - fleet run 20261106-095658-2926651-m9d4162203dc0
  - agent f7900465-cee2-467f-95ce-f54854ebd8be
  - PR #1725
  - commit 2731bfe53f7ace99196021906b423b2a6296766a
repro: agents/tests/blackbox/browser_tilion.blackbox.py::test_state_fetch_restores_a_dropped_cdp_socket_when_no_reconnect_is_running
status: mitigated
---

## Problem

In `agent-payment-new-user-journey` the first browser activity paused for a
payment card, resumed on a replacement Tilion session, typed three card fields,
and at 10:20:27.7Z (about 29 s after attach, 280 ms into typing the expiry) every
state read began failing with `ValueError: Expected at least one handler to
return a non-None result` while both `DownloadsWatchdog` and `DOMWatchdog`
showed completed. Eight supervisor recoveries ran 60 ms apart (all of
`BROWSER_SUPERVISOR_MAX_RECOVERIES`), the activity failed, and the evaluator's
ordered contract rejects any errored browser spawn. The root agent then started
a retry browser that completed the payment, so the task failed only on the first
spawn's `status=ERROR`. Evidence: Hub agent record (messages 38-62 and 63-131
with timestamps), decrypted trace-archive browser-resume/recording artifacts.

## Diagnosis

1. Symptom: `get_browser_state_summary` raised the bubus "none did" error.
2. Why 1: browser-use `watchdog_base.unique_handler` returns `None` for every
   non-lifecycle event when `is_cdp_connected` is False and `is_reconnecting` is
   False (silent skip, browser_use/browser/watchdog_base.py ~line 98), so
   `event_result(raise_if_none=True)` raises. The 60 ms spacing of the eight
   failures shows the skip path (no waiting) rather than a freeze or timeout.
3. Why 2 (owned): Rose's step observation treated that ValueError as a page
   problem; `DOMService` had no handling for a dead socket, and the supervisor
   recovery (page reload on a dead stack) consumed the whole recovery budget
   in 0.5 s, before any reconnect could finish.
Not observed: why the socket dropped at that instant and why browser-use's own
drop callback did not already have a reconnect running. The guest worker log was
not preserved (ClickHouse, Hub record and Render hold none of it; the browser
console/network diagnostics for the task show no crash). This part is an open
observability gap; the provider's close code was not captured. A clean provider
drop (code 1011) recovers on its own in 0.7 s (local run), so the incident
differs from a plain drop.
Local repro: with the drop callback suppressed, a dropped Tilion socket makes the
state read fail with the identical ValueError (fails pre-fix, 2.2 s).
The exact benchmark was not reproduced locally pre-fix (about 1 failure in 15
recent runs of this task); outcome proof comes from the deploy's cloud smoke
lane running the unchanged task.
Golden reference: not applicable (no approval-gated hunk).

## Solution

`DOMService._browser_state_summary` wraps the three `get_browser_state_summary`
call sites: on a failed fetch with the CDP socket down it waits for browser-use's
reconnect, or starts browser-use's own `_auto_reconnect` after a 1 s grace, then
retries once. If the socket stays down it raises `BrowserCdpConnectionLost`
carrying the multiplexer's `last_upstream_close` (the missing capture). No
effect while connected or during an intentional stop. 10k agents: per-agent,
no shared state, one extra bounded wait only on a dead socket.

## Human feedback

None recorded.

## Reusable lesson

When a library silently skips handlers on a dead connection, make the owning wrapper restore or name the dead connection instead of letting a generic "no result" error reach recovery loops.
