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
  - It reads Chrome's own target list with `DOMService.live_frame_targets()`
    (`Target.getTargets`, a browser-process call with no renderer round trip,
    bounded at 5 s). The live focused page is found by the target ID from
    `get_parked_page_identity()`. Either call raises, and so fails closed,
    when no live page or target list can be read.
  - The page counts as in the realm if either Chrome's live URL or the
    registry's focused URL is in it. During a slow `goto`, Chrome already
    reports the pending URL while the realm document is still on screen
    (second independent review).
  - It deliberately ignores browser-use's own target registry for frames. In real
    Chromium, an out-of-process iframe attaches before its navigation
    commits, so the attach event carries `url ''`. browser-use's duplicate
    attach handler then overwrites the URL that `targetInfoChanged` had
    stored. The registry keeps `''` until the frame navigates again
    (verified by the second independent review).
  - For interactions it refuses while any frame on the page is in the realm.
    It walks every node of the last snapshot's selector map to its frame
    chain: the node's target URL (from Chrome's live list) plus each
    enclosing `<iframe src>`. An IFRAME element is judged by its own
    content document. A per-target-frame rule was tried first and rejected.
    Pointer input is delivered at coordinates, including an indexed
    element's and the password-field fallback's frame-relative point, and
    keys go to browser focus. So a realm frame anywhere on the page can
    receive an action aimed at a public element. CodeRabbit found this on
    #2060 cycle 2.
  - The snapshot omits small, hidden and node-less frames. So it also refuses
    while Chrome's target list holds any out-of-process `iframe` target in
    the realm (CodeRabbit, cycle 3). That list gives iframes no tab
    ownership, so a realm frame in another tab also counts. That is
    conservative, and a cross-site phone-harness frame is not a legitimate
    embed. `test_phone_provider_boundary_sees_real_chrome_out_of_process_realm_frames`
    proves this in real Chromium, with hosts mapped to a local server:
    - On the browser-use-registry version (`9a4da63ac7`), a click on a page
      with a 2x2 `accounts.phone-harness.com` iframe returned
      `{'success': True}`.
    - With the fix, it is refused.
    - A page with an ordinary cross-site iframe still allows the click.
  - `_iter_payment_fill_targets`, the frame scan behind the password-field
    coordinate fallback and the payment-fill helpers, skips realm frames
    (Playwright frames by live `frame.url`, CDP targets by their frames'
    URLs). Those helpers evaluate and click in every frame of the page.
  - `evaluate` runs in the main frame only. Terminal actions keep PR #2028's
    observed-URL check, because they do not act on page content.
  - There is no Playwright request routing.
- The refusal reuses PR #2028's result and text (`code=phone_provider_account_boundary`).
  The brokered `phone` action returns before both checks. Read, leave and
  terminal actions are unchanged. `scroll`/`dropdown_options` stay refused
  in the realm.

10k agents: per acting action, one browser-process `Target.getTargets` call
to that agent's own browser. For interactions, each node in that agent's own
cached selector map is also walked up its parent chain (nodes x DOM depth).
There is no shared state or lock across agents.

Residual risk (reviewer-confirmed):
- The re-check runs before the humanized mouse movement, dwell and
  per-character typing. A navigation that commits while the action is running
  (hundreds of milliseconds to seconds) still receives the rest of that action,
  instead of a whole LLM step as before. Closing that window needs request
  interception, which is ruled out by the Stripe Elements breakage.
- In-process frames are known only by their snapshot `src`. This matters
  only when site isolation is off, because a cross-site phone-harness frame is
  otherwise an out-of-process target, and those are read live from
  Chrome.
- A frame Chrome has not yet created as a target when the action starts is
  not seen.
- If UTS-46 data in `idna` lags Chrome's ICU, characters assigned after that
  data could still map differently.
- Interactions now fail closed ("Focused browser target is unavailable") in
  the moments browser-use has no registered focused target.
- `live_frame_targets` sends on browser-use's root connection without waiting
  for a reconnect. If the socket drops between the step's page read and the
  action, the interaction fails, or after 5 s is treated as a CDP stall and
  recovered. Each interaction on a remote provider also pays one more
  browser round trip.
- Site isolation is decided by the provider's Chrome flags. If a provider
  runs `--disable-site-isolation-trials`, a cross-site realm iframe has no
  target and is seen only through the snapshot's `src`. That is still open
  for Steel, Kernel and Tilion.
- A realm frame in any tab blocks every tab, and the refusal names the
  focused tab's URL, not the frame's. Naming the frame would change
  LLM-visible text, which needs the approval gate. Follow-up.
- The real-Chromium regression's failure on `9a4da63ac7` depends on the
  Chrome build. On Playwright's headless shell the registry sometimes held
  the right URL. It always guards the new behavior.

Independent review (fresh sub-agent, RCA step 7): it reached the same first
bad boundaries independently. It then found UTS-46 forms, IFRAME-element
indices, drag coordinates and `0x.0x.0x.0x` gaps in the first fix; each is now
fixed and pinned in the regressions above. CodeRabbit (#2060 cycles 1-2) found
`press_key` with an index, the frame-scanning password and payment fill
helpers, realm frames overlaying a public element's click point, and realm
frames the snapshot omits. All four are fixed and pinned in the same
regression. A second fresh-sub-agent review of the cycle-3 fix found that
browser-use's registry holds `''` for those frames. The boundary now reads
Chrome's target list, and the real-Chromium regression pins this.

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
