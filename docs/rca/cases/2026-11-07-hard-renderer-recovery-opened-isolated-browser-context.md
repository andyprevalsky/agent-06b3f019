---
id: 2026-11-07-hard-renderer-recovery-opened-isolated-browser-context
date: 2026-11-07
title: Hard renderer recovery resumed the task in a fresh BrowserContext without the injected login cookies, so DoorDash served a guest consumer
surface: agents
component: spawn-browser-agent-v3-renderer-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py _hard_recover_frozen_renderer_page — opened the replacement page in playwright_browser.new_context() (an isolated Chrome BrowserContext with an empty cookie jar and no site storage) while the backend injects session cookies into the CDP default context (back-end/src/providers/steel/injection.ts browser.contexts()[0].addCookies)
symptoms:
  - "Hard recovery after renderer-frozen action timeout actions=[new_context_page, goto_resume_url, close_target:..., closed_targets:3, close_playwright_page] recycled=true"
  - "Expected attention kind payment_approval, observed auth_assistance"
  - DoorDash consumer_id changes after hard recovery and consumer-business-profile/v1/business-profiles returns 401
  - rotating_search lat/lng falls back to getGeoByIP after renderer recovery instead of the saved address
  - request_user_assistance_for_authentication after a renderer freeze on a logged-in site
tags:
  - browser
  - renderer-recovery
  - browser-context
  - cookies
  - session-state
  - tilion
  - doordash
  - auth
  - reproduced
sources:
  - agent 18808d56-b80e-4b2f-831d-43290f29481b
  - fleet run 20261107-212636-3543862 anti-bot-doordash-store r001-j0007 (campaign-20261107-211039-3331466, descend-failed-neverrun-20261106 H-63)
  - fleet run 20261107-221034-448034 anti-bot-doordash-store r2 (same campaign, PASS, no renderer freeze)
  - commit 223c1a943b (introduced new_context() preference)
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_hard_recover_frozen_renderer_keeps_session_browser_context
status: open
---

## Problem

`anti-bot-doordash-store` r1 (Tilion, source 268e9550b0) failed with
`Expected attention kind payment_approval, observed auth_assistance`. The
session started logged in. The backend selected the right bundle (chrome
`Profile 1`, `f35fd046`) and injected 159 cookies into `browser.contexts()[0]`.
The localStorage/IndexedDB injection failed with `navigation to a non-public
address is blocked`, as it does in passing runs. DoorDash requests carried the
user's consumer id 21:55:41–21:57:24, and getConsumerOrdersWithDetails returned
200.

21:57:30–22:01:24: the renderer on `/convenience/store/738185` froze. The CDP
page session went silent for 236 s. At 22:01:20 the stall classifier reported
`renderer_main_thread_blocked`. At 22:01:24 hard recovery logged `actions=
[new_context_page, goto_resume_url, close_target:E9473E1DF470, close_target:
9997A84D6E97, close_target:E14AA45B7A38, closed_targets:3,
close_playwright_page]`.

After recovery, the worker log's URLs show a different session. From
22:03:57 every request carried a new consumer id (different sha256 prefix:
`8e31694c` before, `36c65a6f` after). `consumer-business-profile/v1/
business-profiles` returned 401 eight times. `rotating_search` moved from the
SF address (37.79/−122.39) to an IP guess (39.04/−77.49), and `getGeoByIP` ran.
The agent filled a guest cart, reached `/consumer/checkout`, saw that it was
signed out, and called `request_user_assistance_for_authentication` at
22:07:02.

The passing r2 in the same campaign had no renderer freeze and no hard
recovery.

## Diagnosis

Critical path: saved cookies → `browser.contexts()[0].addCookies` (backend
injection) → page in the default context, logged in → renderer freeze →
`_hard_recover_frozen_renderer_page` → replacement page → DoorDash requests →
the agent's auth judgement → evaluator.

1. **First bad data.** The replacement page sent no session cookies. In the
   production log, the action `new_context_page` means the replacement page came
   from `playwright_browser.new_context()`. That call is
   `Target.createBrowserContext`, an isolated, incognito-like context with its
   own cookie jar and storage. The backend had put the session only in the
   default context. All three doordash.com targets in the default context were
   then closed, so the task continued in the empty context. DoorDash created a
   guest consumer. The new consumer id and the 401s show that authentication
   was actually lost. The agent's "not signed in" conclusion was **truthful**,
   not a misreading.
2. **Why recovery switched contexts.** Commit 223c1a943b chose `new_context()`
   on purpose: "under a pegged renderer, context.new_page() can fail with
   'Please use browser.new_context()'". Playwright raises that error only when
   the context has an *owner page*, meaning it was created by
   `browser.new_page()` (`playwright/_impl/_browser_context.py:350`). The
   original hard-recovery blackbox tests build their page that way. Production
   contexts are the CDP default context, which no page owns. So the design
   followed a test-fixture artifact, not a production failure.
3. **Deepest owned cause.** No contract or test said that recovery must keep
   the task in the browser context that holds its session state. Both
   recovery tests used unauthenticated `about:blank` pages in an owned
   context, so losing the session could not show up.

There is no geolocation emulation to re-apply: Rose never sends
`Emulation.setGeolocationOverride`. DoorDash takes its location from the signed-in
consumer's saved address, so the IP fallback was a result of the guest
session. CdpMux applies timezone, locale and UA emulation per target when a
target attaches, whatever its context. The repeated `setTimezoneOverride
holder ... re-apply failed: Session with given id not found` errors are
separate CdpMux noise. They did not change this outcome.

Archive searches: `hard recovery renderer frozen new_context_page cookies
lost logged out` and `auth_assistance instead of payment_approval doordash
session lost after recovery fresh browser context`. This is a relative of
`2026-08-21-evaluate-timeout-poisons-js-thread-blocks-recovery`, which
introduced hard recovery. The failure is new. It is distinct from H-37 (wrong
bundle selected) and from
`2026-11-06-playwright-not-reattached-after-provider-cdp-socket-drop`
(Playwright transport loss).

Repro: `test_hard_recover_frozen_renderer_keeps_session_browser_context` uses
the production shape. Real Chromium is reached through `connect_over_cdp`. A
session cookie is added to `browser.contexts[0]`, and an HTTP server records
the cookie names on each request. The test freezes the renderer, checks that
the classifier says `renderer_main_thread_blocked`, and runs hard recovery
with the store URL as the resume URL. On 268e9550b0 it failed with the same
action signature as production:
`AssertionError: resumed navigation lost the session cookie: [('/store', [])]
actions=['new_context_page', 'goto_resume_url', 'close_target:1DDE04289B1B',
'closed_targets:1', 'close_playwright_page']`.

## Solution

`_hard_recover_frozen_renderer_page` now creates the replacement page with
`context.new_page()` in the frozen page's own BrowserContext. It no longer
creates a fresh context, so cookies and site storage stay with the task. If
that page cannot be created, it returns `None` with
`context_new_page_failed:<Exception>`. It never resumes silently in an
empty jar.

Order: create the blank page first, so closing the last target cannot tear
down the context. Close the hung targets next, then navigate to the resume
URL. A same-site navigation therefore cannot land in the blocked renderer
process.

The recovery actions now end with `context_cookies:<before>-><after>`. It
counts only and never records names or values. The next run can then show
from the log alone that the cookie jar survived.

The two existing hard-recovery tests now build their page with
`browser.new_context().new_page()`, which no page owns, matching
production. Their assertions are unchanged.

The fix also covers sibling failures:
- any authenticated browser task (Amazon, Target, OpenTable, …) that
  hard-recovers would resume logged out;
- `_capture_rotation_storage_state` reads `page.context`, so a staged
  auth-preserving challenge recovery after a hard recovery would capture and
  carry the empty context;
- localStorage and IndexedDB in the session context were dropped as well.

10k agents: one in-context page and at most two bounded browser-level
`Storage.getCookies` calls per classified freeze. There is no shared state and
no fan-in.

Golden reference: OpenClaw
`openclaw/extensions/browser/src/browser/pw-session-actions.ts:551-567` opens
new tabs in `browser.contexts()[0]`. It creates a new context only when the
caller explicitly asks for isolation. The fix follows the same pattern.
Searched with no analog: hermes-agent, codex and claude-code-src have no
Playwright/CDP page lifecycle. The kimi-code clone was missing.

Causal proof: done (red on 268e9550b0, green after the fix, five consecutive
green runs). Outcome proof is still pending. The freeze is
nondeterministic: r2 passed on the same buggy source without a freeze. The
exact unchanged `anti-bot-doordash-store` must pass on a descend cloud member
rerun. Status stays `open` until that rerun passes.

## Human feedback

None recorded.

## Reusable lesson

Recovery that replaces a browser page must create the replacement in the
BrowserContext that holds the session's cookies and storage, and must never
open a fresh `new_context()` behind an authenticated task.
