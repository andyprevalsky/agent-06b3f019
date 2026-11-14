---
id: 2026-11-14-phone-provider-boundary-judged-stale-url-and-urlparse-host
date: 2026-11-14
title: Phone-provider account boundary judged the step-start URL and urlparse's host, not the live page, frame and Chrome's host
surface: agents
component: spawn-browser-agent-v3 service_actions execute_action
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py _phone_provider_account_refusal decided the realm from current_url observed at step start and from urlparse(url).hostname
symptoms:
  - phone_provider_account_boundary
  - "https://phone-harness.com\\@example.com/"
  - "https://phone-harness%2ecom/"
  - "https://169.254.169.254\\@example.com/"
  - Refusing unsafe navigation
tags:
  - security
  - phone
  - browser-credentials
  - broker-boundary
  - url-parsing
  - iframe
sources:
  - PR #2028
  - commit ccc17b0348
  - agent af4f4bb3
repro: agents/tests/blackbox/browser_credentials.blackbox.py::test_phone_provider_boundary_rechecks_the_live_page_and_target_frame_at_action_time
status: fixed
---

## Problem

PR #2028 made `execute_action` refuse acting actions on, and navigation into,
the phone-provider account realm (`phone-harness.com`). An independent
post-merge review (agent af4f4bb3, 2026-11-14) found no exploit but two gaps,
both reproduced locally against main `f0bc6ec277`:

1. Stale URL and frames (MEDIUM). The check used `current_url`, the URL the
   handler observed at step start. A non-realm page that redirects or
   meta-refreshes to `accounts.phone-harness.com/device` after observation was
   acted on. On main, a `click` at index 7 with a live page of
   `https://accounts.phone-harness.com/device` and an observed URL of
   `https://example.com/start` reached `get_click_coordinates`, so the
   dispatcher was driving the browser. A cross-origin phone-harness iframe
   inside an ordinary page was never checked at all.
2. URL forms (LOW). The `goto`/`open_new_tab` target check used `urlparse`,
   which disagrees with Chrome's WHATWG parser. `https://phone-harness.com\@example.com/`
   was judged `example.com`, but Chromium's `new URL()` gives `phone-harness.com`.
   The same was true for `https://phone-harness%2ecom/`, fullwidth dots and letters,
   the ideographic full stop, soft hyphens, `https:phone-harness.com` and
   backslash-only authorities.

Sibling found during this RCA (same class): `_non_public_navigation_reason`
also read the host with `urlparse`. `https://169.254.169.254\@example.com/latest/meta-data/`,
`https://127.0.0.1\@example.com/` and `https://127%2e0.0.1/` passed the
non-public navigation guard, while Chromium navigates to the private address.

## Diagnosis

1. First bad boundary: `_phone_provider_account_refusal` decided the realm
   from data that is not what Chrome acts on. `current_url` is
   `runtime_current_url` from `observe_state` at step start (handler.py
   ~10571), so any navigation that commits before dispatch makes it stale.
   Frames were out of scope by construction.
2. Why it was possible: the boundary was written against a page *model*: one
   URL per step, parsed by Python. The browser has a live main-frame URL per
   focused target (browser-use keeps `session_manager` targets current from
   `Target.targetInfoChanged`). It also has one target per out-of-process
   iframe, and it parses URLs with WHATWG rules: in special schemes a
   backslash is a slash, leading slashes are skipped, the host is
   percent-decoded and IDNA-mapped.
3. Why urlparse mattered beyond the realm: the non-public navigation guard
   used the same model, so the same parser gap reached private addresses.
   Chrome's own parser is the oracle. The regression asserts that Chromium's
   `new URL()` agrees with every form.

Archive searches: `rca_archive.py search "stale current_url redirect iframe action boundary realm"`
and `"urlparse backslash hostname WHATWG percent-encoded host IDNA fullwidth"`,
plus a `grep` for WHATWG, meta-refresh and cross-origin iframe. This case is a
relative of 2026-11-13-agent-browser-approved-phone-provider-cli-grant: it is
a precision gap in that guardrail found by review, not a recurrence. Its
lesson applies: the dispatcher stays the boundary, and `context.route` stays
off because it breaks Stripe Elements. 2026-11-05-checkpoint-enumerated-detached-iframe
and 2026-10-16-observed-page-result-missing-from-action-receipt matched on
keywords only and do not apply.

## Solution

All in `agents/domains/spawn_browser_agent_v3/service_actions.py`:

- `_browser_url_host` follows Chrome's host parsing. It strips C0 controls
  and spaces, removes tab and newline, reads a backslash as `/`, skips
  leading slashes, drops userinfo up to the last `@` and takes the authority
  up to the first `/?#`. It then percent-decodes the host and maps it with
  UTS-46 (non-transitional, from the `idna` package that `httpx` already
  requires). That mapping covers fullwidth forms, ideographic full stops,
  subscript and enclosed letters, and ignorables such as soft hyphens and
  variation selectors. `blob:` URLs use their creator's origin. A host that
  UTS-46 cannot map raises: the realm check then reports no realm (Chrome
  refuses such hosts), and the non-public guard refuses the URL as malformed.
  `phone_provider_account_realm` and `_non_public_navigation_reason` both use
  it. The guard also parses numeric hosts with WHATWG's IPv4 rules
  (`_whatwg_ipv4_host`, e.g. `0x.0x.0x.0x` is 0.0.0.0), replacing the
  regex-plus-`inet_aton` check.
- `_live_phone_provider_account_refusal` runs in `_execute_resolved_action`
  just before dispatch, after secrets are resolved and the element is
  looked up. It applies to every action that acts on page content
  (interactions and `evaluate`):
  - It reads the live focused page with `DOMService.get_parked_page_identity()`.
    This is the browser-side target registry, the same source as
    `get_current_page_url`, with no renderer round trip. It raises (fail
    closed) when no live focused page exists.
  - For interactions it checks the frame chain of each indexed target: each
    node's target URL (for an out-of-process frame, live) plus each enclosing
    `<iframe src>`. An indexed IFRAME element is judged by its own
    content document, not by the parent page.
  - The target frame counts as undeterminable when coordinates are given
    (`x`/`y`/`coordinates`/any `*_x`/`*_y`), when there is no index (keys,
    `input_text` without an index), or when an index is not an integer. Then
    the action is refused if the last snapshot shows any realm frame on the
    page.
  - `evaluate` runs in the main frame only. Terminal actions keep PR #2028's
    observed-URL check, because they do not act on page content.
  - There is no Playwright request routing.
- The refusal reuses PR #2028's result and text (`code=phone_provider_account_boundary`).
  The brokered `phone` action returns before both checks. Read, leave and
  terminal actions are unchanged. `scroll`/`dropdown_options` stay refused
  in the realm.

10k agents: per action, one in-memory target lookup. For index-less
interactions, each node in that agent's own cached selector map is walked up
its parent chain (nodes x DOM depth). There is no I/O, shared state or lock.

Residual risk (reviewer-confirmed):
- The re-check runs before the humanized mouse movement, dwell and
  per-character typing. A navigation that commits while the action is running
  (hundreds of milliseconds to seconds) still receives the rest of that action,
  instead of a whole LLM step as before. Closing that window needs request
  interception, which is ruled out by the Stripe Elements breakage.
- In-process frames are known by their snapshot `src`, not live. This matters
  only when site isolation is off, because a cross-site phone-harness frame is
  otherwise an out-of-process target.
- A frame injected after the snapshot, or an out-of-process frame whose target
  is briefly missing from the registry, is not seen.
- If UTS-46 data in `idna` lags Chrome's ICU, characters assigned after that
  data could still map differently.
- Interactions now fail closed ("Focused browser target is unavailable") in
  the moments browser-use has no registered focused target.

Independent review (fresh sub-agent, RCA step 7): it reached the same first
bad boundaries independently. It then found UTS-46 forms, IFRAME-element
indices, drag coordinates and `0x.0x.0x.0x` gaps in the first fix; each is now
fixed and pinned in the regressions above.

Repro, identical command before and after:
`BLACKBOX_CASE_FUNCTIONS=test_phone_provider_boundary_rechecks_the_live_page_and_target_frame_at_action_time,test_phone_provider_boundary_reads_urls_the_way_chrome_does python scripts/run_blackbox_tests.py browser-credentials`
(from `agents/`).
On main it exits 1 with `AssertionError: ({'action': 'click', 'index': 7, 'params': {}}, {'success': False, 'error': 'get_click_coordinates'})`
and `AssertionError: https://phone-harness.com\@example.com/`. With the fix it
exits 0. The sibling guard's repro is `test_url_looks_like_api_surface_guard`
in `spawn-browser-agent-v3`.

## Human feedback

The coordinator scoped this to the two review findings and ruled out
`context.route`, string classifiers over LLM text and runtime nudges. They
also said to leave `scroll`/`dropdown_options` refused, and not to act on the
phone, call Connect, resume prod agents or touch the owner's phone-harness,
Apple or Google accounts.

## Reusable lesson

A browser security boundary must judge what Chrome will act on, when it acts: the live target URL, the target frame, and the host that Chrome's WHATWG and UTS-46 parsing yields. A step-start URL or urlparse's reading is not enough, and Chromium's `new URL()` is the test oracle.
