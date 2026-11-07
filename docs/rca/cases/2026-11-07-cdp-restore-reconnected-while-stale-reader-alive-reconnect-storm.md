---
id: 2026-11-07-cdp-restore-reconnected-while-stale-reader-alive-reconnect-storm
date: 2026-11-07
title: The state-read CDP restore started browser-use's reconnect while the dead client's reader was still running, setting off a self-sustaining reconnect storm
surface: agents
component: browser-tools-dom-service-cdp-restore
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/dom_service.py DOMService._restore_cdp_connection called BrowserSession._auto_reconnect() while the closed root CDP client's _message_handler_task was still running. browser-use's reconnect() then cancelled that reader inside its own reconnect window, and the reader's drop callback recorded _reconnect_pending.
symptoms:
  - "CDP socket is down and no reconnect is running (intentional_stop=False reconnecting=False reconnect_pending=False); starting browser-use reconnect"
  - "🔄 WebSocket reconnected after 0.8s (attempt 1)" followed immediately by "🔄 WebSocket reconnection attempt 1/3..." hundreds of times
  - "[SessionManager] Failed to enable monitoring for target 0F81FE81...: Client is stopping"
  - "No valid agent focus available - target may have detached and recovery failed. This indicates browser is in an unstable state."
  - "[CdpMux] Upstream CDP socket released (label=session:...)" then "Upstream CDP socket attached (... opened=N)" with N climbing every second
tags:
  - tilion
  - cdp-multiplexer
  - browser-use
  - reconnect
  - event-loop-lag
  - descend-h47
sources:
  - agent 0812399f-26cd-4e5e-8717-770568abde2a
  - fleet run 20261107-074050-3000991 anti-bot-lulus-emerald-dress r002-j0028 (campaign-20261107-064548-1363251, batch3 epoch16 source 005f823662, descend H-47)
repro: agents/tests/blackbox/browser_tilion.blackbox.py
status: open
---

## Problem

The anti-bot-lulus-emerald-dress run on Tilion timed out at 1802 s (agent
0812399f, epoch16 source 005f823662, which already contains the H-41
Playwright reattach). The browser reached the Lulus bag and
/checkout/shipping. From the worker log:

- 07:57:44–07:58:19: `loop.lag` fired about every second (0.3–1.76 s) at only
  16–40% of one core. The asyncio task count rose from 81 to 536.
- 07:58:20.268: `[CdpMux] Upstream CDP socket released`, meaning the last local
  client had left. Nothing logged why.
- 07:58:24.502: `_restore_cdp_connection` logged `CDP socket is down and no
  reconnect is running (... reconnecting=False reconnect_pending=False);
  starting browser-use reconnect`.
- Reconnects then ran from 07:58:31 to 08:02:02: 470 `WebSocket reconnected
  (attempt 1)`. Each one was followed within 2 ms by `reconnection attempt
  1/3`, `Failed to enable monitoring ...: Client is stopping`, `[SessionManager]
  Cleared all owned data` and a mux release/attach pair.
- 07:58:35: Playwright was reattached by H-41. browser-use focus could never
  settle: `No valid agent focus available` x12 and `No focused target` x13.
- The browser agent returned a blocked report without `request_payment_card`.
  The root then looped until the 1800 s timeout.

`🔌 CDP WebSocket message handler exited unexpectedly` never appears for the
original client. Its drop callback had therefore not fired when the restore
started the reconnect.

## Diagnosis

Critical path: socket drop → `DOMService.get_browser_state` → `_browser_state_summary`
→ `_restore_cdp_connection` → `BrowserSession._auto_reconnect` → `reconnect()`.

1. The closed root client's websocket was no longer OPEN, so
   `is_cdp_connected` was False. Its `_message_handler_task` was still running:
   under loop lag it was still inside event handlers and the queued backlog.
   browser-use's drop callback only fires when that task finishes. The 1.0 s
   start grace also ran out, because at 0.5–0.9 s per loop tick it covers only
   one or two ticks.
2. `_restore_cdp_connection` then called `_auto_reconnect()`, which sets
   `_reconnecting=True`. `reconnect()` step 1 calls the old client's `stop()`,
   which cancels the still-running reader. The reader's done callback
   (`_on_message_handler_done`) sees `_reconnecting=True` and sets
   `_reconnect_pending=True`.
3. The reconnect succeeds. Its `finally` block sees the pending flag and
   schedules another `_auto_reconnect`. That run stops the new healthy client,
   whose reader callback was attached in step 8. The callback re-arms
   `_reconnect_pending`, and the cycle repeats without end. Every cycle clears
   the SessionManager and agent focus, so the H-41 Playwright reattach could not
   restore a usable browser-use session.
4. Deepest owned cause: browser-use's reconnect assumes the old client's reader
   has already ended. Its own drop path always meets that, because the reconnect
   starts from that reader's done callback. Rose's restore path broke that
   contract. Why 5 would be browser-use's callback not distinguishing its own
   reconnect's `stop()` from a drop. That is third-party code at a pinned
   version (0.13.11), so the ladder stops at Rose's trigger.

Local repro, `test_state_fetch_restore_with_a_live_stale_reader_reconnects_once`
in `agents/tests/blackbox/browser_tilion.blackbox.py`: real Chromium,
FakeTilionGateway, the real CdpMux and the real DOMService/browser-use. The test
holds the root reader inside a `Page.lifecycleEvent` handler, the way the
loop-lag backlog does, then calls `gateway.drop_all()`. That gives a
not-OPEN socket with a live reader. A state read follows.

- Buggy revision (7555a20d05, whose dom_service/cdp_multiplexer are identical to
  005f823662): `FAIL ... AssertionError: reconnect storm: 9 root CDP clients and
  13 upstream dials within 5s of the restore`.
- Fixed: `PASS ... 8.8s`, with one root client and 2 upstream dials.

### Independent causes in the same run, kept separate

- **Load / loop lag (H-50, separate owner).** BrowserNetworkRecorder captured
  each response body N times, with N rising from 2 to 17 between 07:52 and
  07:57. That is 2,765 captures of 346 unique requests and 27 MB of synchronous
  `write_bytes`, plus one log line each. The likely mechanism is Network events
  delivered on several accumulated CDP sessions per target, with no per-request
  dedupe. This case does not fix it.
- **Why the socket dropped at 07:58:20: an open observability gap.** The mux
  logged only `Upstream CDP socket released`. The old browser-use client later
  reported `received 1000 (OK); then sent 1000 (OK)`, so the mux side closed it
  first. That fits `_serve_client` returning after a `ConnectionClosed` raised by
  an upstream send while the client's own socket was open. A provider or
  keepalive close would then be masked: `_close_upstream` nulls `_upstream`
  before the reader logs `Provider closed the CDP socket`. Not reproduced. The
  missing capture is added (see Solution).

## Solution

On branch `rca/h-47-20261107`:

1. `DOMService._restore_cdp_connection`: when the socket is down, no reconnect
   is running and the root client's reader is still running, cancel that stale
   reader once and wait for it to finish. browser-use's own drop callback then
   starts its single reconnect outside a reconnect window. The restore waits on
   that reconnect through the existing loop. The direct `_auto_reconnect()` call
   remains as a fallback for when no reconnect starts. This only reorders the
   reader shutdown that `reconnect()` itself performs. It adds no fallback and
   does no string matching.
2. `SingleCdpConnectionMultiplexer` (log-only):
   - Every local client exit logs `Local CDP client N left (code, reason,
     closed_first_by, ended_by, clients_left)`. `ended_by` names an upstream
     `ConnectionClosed` caught while the client's socket was still open.
   - `_close_upstream` warns `Upstream CDP socket was already closed when
     released (code, reason, closed_first_by)` before nulling `_upstream`.
   - The regression is `test_multiplexer_logs_who_closed_each_cdp_socket`.
     Without the change it fails, and the log contains only `attached`/`released`.

Siblings this prevents: every restore while a reader is busy, such as large DOM
snapshots or response-body floods under loop lag. Without the fix each of those
turned one transient drop into a storm that destroys focus.

10k-agent behaviour: per-browser-session work only. At most one cancelled reader
and one reconnect per drop. No shared state or new channels.

Golden reference: not applicable (no approval-gated hunk). This is transport
reconnect ordering and logging, with no prompt, schema or agent
recovery-semantics change.

Outcome proof is still pending. The exact `anti-bot-lulus-emerald-dress` rerun
was not run under this assignment's no-benchmark constraint, so the case stays
open until a descend rerun passes. The drop cause also stays open until the new
logs capture the next occurrence.

## Human feedback

None recorded.

## Reusable lesson

Before starting a library reconnect from outside its drop callback, end the dead client's still-running reader first: a reconnect that cancels a live reader re-arms itself forever.
