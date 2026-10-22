---
id: 2026-10-21-tilion-gateway-drops-pipelined-cdp-key-events
date: 2026-10-21
title: Tilion's CDP gateway drops pipelined Input.dispatchKeyEvent, so humanized fire-and-drain typing timed out
surface: agents
component: browser-humanizer-cdp-keyboard-transport
classification: third-party-failure
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/humanizer.py _type_text_with_cdp_fire_and_drain pipelines rawKeyDown/char/keyUp on one CDP session; Tilion answers and delivers only key events sent while no other is in flight
symptoms:
  - CDP keyboard input drain timed out after 15s
  - "Browser action 'input_text' timed out with unknown timeout source (configured supervisor cap 330s); generic browser supervisor recovery ran."
  - action_timeout_input_text_unknown_source
  - renderer_responsive_after_timeout
  - "Key pressed Backspace then no further key events until 'Browser action timed out' (~19-20 s)"
tags:
  - tilion
  - cdp
  - humanizer
  - keyboard
  - input-dispatch
  - single-cdp-client
sources:
  - agent 91514d73-d944-4922-847a-d8b2aef71e8e (sess_9e309868b0d246d1adefb2fde390738d, integration 08339e80d)
  - agent b0f841a5-5d35-4c79-8b13-f20ecf54bdcb (sess_3d245e7ef1c84d49a3bb9973d9f6b352, integration f5ece1e59)
  - agent 4ea62dd1 (sess_3d245e2aa8704c98ad7db5fd9d3a7714), agent f3f6a7c8-f72f-4756-afaf-427e9628eec7 (sess_9e30988253584f1fb9490a64cf0ddf3e)
  - agent ae817ca5-5f7b-4045-9f0d-d0cf6135cd18
  - commit 658e9db36 (agents/scripts/tilion_cdp_input_probe.py live vendor repro)
repro: agents/scripts/tilion_cdp_input_probe.py (live Tilion) plus the BrowserHumanizer serial-keyboard regression handed to lane C for agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: open
---

## Problem

On Tilion, `input_text` failed after ~19-20 s on every task that typed into a
field: browser-biometrics-webdecoy (fcaptcha demo, ended in a 424 s timeout)
and browser-auth-passkey-preferred, password-email-2fa and
saved-password-retry (4 occurrences). The worker logged `Key pressed
Control+a`, `Key pressed Backspace`, then nothing until
`Browser action 'input_text' timed out ... unknown timeout source`. The
stall probe said `renderer_responsive_after_timeout` (Runtime answered in
~140 ms). Kernel passes the same tasks 96% (webdecoy) and 19/20 (auth).

## Diagnosis

Live Tilion, direct CDP socket (no Rose mux), fresh session per variant,
example.com with an injected plain `autocomplete=off` input:

- 18 `Input.dispatchKeyEvent` (keyDown/char/keyUp for `abcdef`) sent one at a
  time, each awaited: 0 unanswered, field `abcdef`.
- The same 18 pipelined 60 ms apart: 11-13 unanswered after 10 s, never
  answered later, field `bdf` / `dxyz`. With no gap: 17/18 unanswered.
- A later single key on the same session is answered (not a wedge).
- Pipelined `Input.dispatchMouseEvent` (847 events) all answered.

So Tilion drops key events sent while another key event is in flight: no
response and no delivery. `BrowserHumanizer._type_text_with_cdp_fire_and_drain`
(added for remote browsers so the round trip does not inflate dwell) creates
every key send as a task and gathers them after the loop, with a 15 s
`CDP_INPUT_DRAIN_TIMEOUT_SECONDS`. That drain timed out (`CDP keyboard input
drain timed out after 15s`), giving the ~19 s failure. Not the cause: lane C's
single-CDP mux (identical results direct and via mux), PoW/main-thread load
(plain page reproduces), autofill/WebAuthn (plain `autocomplete=off` input
reproduces), and screenshot serialisation (lane B, local Chromium).

Causal repro, real `BrowserHumanizer.type_text` over Playwright
`connect_over_cdp` to live Tilion: integration humanizer
`{pass:false, 18.07 s, "CDP keyboard input drain timed out after 15s", value "ecc"}`;
with serial key dispatch `{pass:true, 13.97 s, value "benchmark-human@example.com"}`.

Not explained yet: the webdecoy click at 23:18:29 (after the drain failure
invalidated the CDP transports) that did not return for 4 min. Candidates are
unbounded `page.evaluate` click-receipt awaits and the Playwright fallback path;
no repro.

## Solution

Proposed (lane C owns the files, diff sent 2026-10-21): `BrowserHumanizer` gets
`serial_cdp_keyboard`; when set, `_type_text_with_cdp_fire_and_drain` awaits
each key event in order (`_dispatch_cdp_key`), keeping the explicit CDP
`timestamp`s so page-visible dwell and flight times stay humanized. The
browser handler sets it from `is_single_cdp_client_provider(provider)`.
Kernel/Steel keep pipelined dispatch. 10k agents: per-session, no shared
state; one in-flight key event per Tilion session. Regression: a fake
single-client gateway that never answers a key sent while another is in flight
(fails on the integration humanizer, passes 5/5 patched). Vendor issue to
report to Tilion with `agents/scripts/tilion_cdp_input_probe.py`. Outcome gate
(`run-bench --local` webdecoy/passkey-preferred on the patched SHA) is pending;
status stays open until it passes.

### 2026-10-22 recurrence after the serial-keyboard fix

The serial fix (C cabf9d2dc) did not clear browser-auth-passkey-preferred
(agent ae817ca5, sess_9e3098527dd5437a9c09103fd3256d1d) or webdecoy (agent
56d5b744): the first serial `rawKeyDown` after Playwright's Control+a/Backspace
went unanswered. Refined live drop rule (two flatten sessions on one target):
keys overlapping keys, mouse or Runtime on ANOTHER session were all answered
(0/20 lost); keys overlapping `mouseMoved` on the SAME session lost a key. So
Tilion drops a key event while any other Input event is in flight on the same
CDP session. The humanizer's idle drift (`start_idle_movement`, every 45-85 ms)
sends `mouseMoved` on the humanizer session while `type_text`/`press_key` run
without `_movement_lock`; after the drain failure invalidates the CDP
transports, idle drift moves to Playwright's page session and overlaps
Playwright `keyboard.press`, which awaits forever (the 5-minute silences). Live
repro on integration 4927729a7: initialize_cursor + start_idle_movement, then
press_key, press_key, type_text -> TimeoutError, empty field. Holding
`_movement_lock` during keyboard dispatch when `serial_cdp_keyboard` -> PASS.
Recommended general fix: the CDP mux serialises Input.* per session for every
client, with a bounded wait that answers the client with an error instead of
hanging. Why the first fix did not hold: it serialised keys against keys only;
the drop condition is any concurrent Input on the session.

## Human feedback

None recorded.

## Reusable lesson

When a remote CDP provider loses input, compare pipelined against one-at-a-time dispatch of the same events on a direct socket before blaming the page, the renderer or a local proxy.
