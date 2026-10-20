---
id: 2026-10-20-steel-opener-isolated-popup-startup-gap
date: 2026-10-20
title: Hosted Steel retains isolated popup POST until provider session release
surface: agents
component: steel-popup-startup
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Hosted Steel retains the native isolated-popup POST before HTTP dispatch; its responsible controller or navigation throttle remains unobserved
symptoms:
  - browser agent just serving a blank white screen on some pages
  - Current URL:  - Empty Tab
  - Empty DOM tree (you might have to wait for the page to load)
  - Failed to enable monitoring for target
  - CDP method 'Page.enable' did not respond within 60s
tags:
  - steel
  - browser
  - popup
  - noopener
  - cdp
  - blank-screen
sources:
  - agent 915ab997-c174-4297-80ac-15347120342f
  - commit 285b8842b156448a801c017e12b2dd66373d6c83
repro: agents/tests/e2e/steel_popup_probe.py
status: open
---

## Problem

A Dallas-to-Paris booking agent reached Google Flights' Continue-to-United
handoff. Two Steel browser activities reported new targets with empty URLs and
titles. The first activity's saved screenshot contains 1,024,000 white pixels
and a three-pixel-wide blue strip, with dimensions 1283x800. This is a real blank
captured view, rather than merely a frontend player presentation failure.

The raw transcript observations at 2026-10-20 01:18:25 UTC and 01:23:31 UTC
reported `Current URL:  - Empty Tab`. A later independent United homepage
navigation produced a populated document. The first activity's retained worker
logs show `Page.enable` failing to respond for 60 seconds at 01:18:17 UTC.
Browser-use synthesizes an empty DOM for an empty cached URL, so its zero-element
count is not independent proof of an empty underlying DOM.

Evidence was downloaded privately under `.context/rca-915ab997/`: the raw
transcript, 111 materialized model-call records plus 46 updates, the first
activity's console/network archives, and retained worker logs. The worker slice
ends at 01:22:37 UTC; it does not prove a second activity's corresponding CDP
timeout. The original agent was active during investigation and was not changed.

## Diagnosis

Critical path: Google Continue control -> native POST form with `target=_blank`
-> Steel popup target -> CDP monitoring/frame observation -> browser-use state
and screenshot -> model and frontend display.

The original model captured a POST form for Google `/travel/clk/f`, but truncated
its outerHTML to 5,000 characters, cutting through the hidden `u` value. Its
subsequent regex/fetch replay returned 404 with an incomplete value. That 404
does not establish failure of the original booking POST. The archived 106-entry
network capture covers the first activity and contains no booking POST; missing
popup-session coverage means this is not proof that the request was never sent.

Local experiments narrowed the boundary without changing production code:

1. A local Chromium synthetic POST popup driven through the real DOMService
   and native mouse events reached a loopback endpoint and returned its marker:
   `PASS: POST popup loads, wall_seconds=3.59`. This endpoint and browser differ
   from Steel, so the control only excludes universal DOMService incapability.
2. A fresh Steel session with DOMService reproduced an empty popup target.
3. Minimal raw CDP, without Rose or browser-use, reproduced the same empty
   URL/title signature on a synthetic POST to `https://example.com/`.
4. A separate raw-CDP experiment with `solveCaptcha=false` also failed. This
   observation does not justify changing production CAPTCHA configuration.
5. In another failing raw session, `Runtime.runIfWaitingForDebugger`,
   `Page.getFrameTree`, and `Runtime.evaluate` each timed out after eight seconds;
   the target remained empty after those checks. Its attach event reported
   `waitingForDebugger=false`. Moving debugger resume earlier is not a proven fix.
6. The versioned reproduction compares two synthetic POST popups in the same
   Steel session, retaining identical browser, proxy, destination and payload:

   `agents/venv/bin/python agents/tests/e2e/steel_popup_probe.py`

   Run on 2026-10-20, Steel session `dfa0663b-e164-4ff5-bd82-aa62dff22e4d`,
   Chrome/154.0.8037.57, revision
   `73c14f6228d7cd537c855007e8f88678969cc0eb`. The diagnostic writes its complete
   nonsecret creation configuration and target/session events.

   - Default isolated popup: empty URL/title, `canAccessOpener=false`,
     `Page.enable` timed out after eight seconds; result false after 14.48s.
   - Synthetic control with `form.rel='opener'`: committed frame URL
     `https://example.com/` with a nonempty loader ID, `canAccessOpener=true`;
     result true after 6.61s.
   - Whole command exited 1, retaining the failed isolated-popup assertion.
     Cleanup readback reported the exact session `released`.

The control changes the fixture's opener semantics. It is causal narrowing,
not a product fix or an unchanged post-fix pass. These observations locate a
reproducible failure in the Steel-provided browser environment independently of
Rose's model, click-coordinate selection and browser-use cache. They do not yet
separate Steel internals, its Chromium build, proxy behavior, or destination
response, nor prove that the original Google POST failed for that identical
internal reason. Classification stays unresolved and status stays open.

Archive searches: `about:blank blank popup Google Flights`,
`browser white screen navigation Fetch requestPaused`, and `popup`. The first
two returned relatives with different boundaries; `popup` had no hit. This is
a novel open case, not a confirmed recurrence.

Adversarial review required narrower claims about synthesized DOM counts,
truncated POST replay, local-control differences, configuration receipts,
same-session comparison and positive cleanup. Those limits are preserved here.

### Continued investigation after the initial findings

The user requested continuation rather than accepting preliminary findings.
The next experiments used a controlled HTTPS fixture: `/form` supplies a complete
random nonce, its native isolated form POSTs to `/handoff`, the server records
the exact bytes and responds 303, and `/done` serves an identifiable DOM marker.
The browser never reconstructs, retries, or navigates around the POST.

- The exact reported hosted build, Chrome/154.0.8037.57 at revision
  `73c14f6228d7cd537c855007e8f88678969cc0eb`, passed locally against that identical
  HTTPS fixture. Local public Puppeteer 23.6.0 also passed, including a tested
  subset of Steel's public launch arguments. The version mismatch in the first
  local control therefore does not explain the hosted failure. Hosted-source
  parity, extensions, private plugins and controller identities remain unknown.
- Hosted baseline, requested headless, no-proxy, CAPTCHA-disabled and
  fingerprint-enabled experiments retained the failure. The same-session
  opener-enabled controls arrived with exactly one intact POST before teardown.
  These are diagnostic controls, not production changes or proposed fixes.
- In hosted session `cdc13e57-69e6-4435-8bc3-895ccdaf6e91`, the observing raw CDP
  client disconnected at 01:59:57.957 UTC. There was still no matching POST at
  02:00:00.961 UTC, and native session status was `live`. Native release started
  at 02:00:01.212 UTC and returned at 02:00:01.465 UTC. The original pending
  POST arrived at 02:00:01.887 UTC, followed by its 303 GET at 02:00:02.034 UTC.
  This establishes retained native navigation with intact data, beyond a mere
  recording or network-observation gap. Release changes several provider states;
  it does not uniquely identify the internal waiter or throttle.
- Browser-process tracing in hosted session
  `0eb111ce-1b36-407b-8210-a5f6136ad4db` captured 380 events. The original
  navigation remains at `WillStartRequest`. Additional-client
  `Target.setAutoAttach`, `Page.addScriptToEvaluateOnNewDocument`, and
  `Runtime.runIfWaitingForDebugger` traffic occurs. Chrome receives the
  observer's `Page.enable` but does not dispatch it to a renderer. The trace
  omits CDP session IDs, command parameters and responsible throttle identity;
  neither "no resume was sent" nor "the correct owner resumed" is proven.
  The earlier trace attempt started before primary-page navigation, timed out
  during that navigation, and produced no trace; it is not popup proof.

The strongest source-backed mechanism was then reproduced locally with two
independent CDP clients. Holding the original owner's **tab** debugger wait
causes a second observer's page attachment to report `waitingForDebugger=false`,
while `Page.enable`, Runtime evaluation and observer-side resume hang. Resuming
the original owning tab releases the existing navigation. The same assertion
then passes, with one original nonce POST, the intended redirect and marker,
and `window.opener === null`. The pinned Chrome 154 HTTPS proof completed the
post-resume assertion in 127 ms. No form mutation or second submission occurred.

The standalone CLI version is
`agents/venv/bin/python agents/tests/e2e/cdp_popup_owner_probe.py`; it runs an
isolated local browser and local HTTP fixture without a provider account or
ephemeral tunnel. `--chrome /absolute/path/to/chrome` selects a pinned build.
This is a causal fail/pass for a deliberately injected local owner wait, not an
unchanged hosted product fail/pass. The initial Chrome 154 version of the
standalone probe also observed newly created browser-UI tabs; its too-broad
ownership assertion was corrected to hold only newly created tabs that
actually report a debugger wait, preserving the initial-target snapshot.
That harness failure is not a product failure.

Source provenance is pinned in
`.context/rca-915ab997/vendor-source-provenance.json`: official Steel source
`d8cfe62eaeb547cb87eeb540f1ffb47998fa485c`, Puppeteer 23.6.0, and Chromium source
at the exact reported revision. Chromium
`content/browser/devtools/protocol/target_handler.cc:814` checks waiting page
and tab owners, and installs a request throttle for opener-isolated navigation.
`content/browser/devtools/devtools_session.cc:379` consumes the resume callback
in the addressed session. Its suspended-message handling explains why an
observer's commands can queue. Public Puppeteer's
`src/cdp/ChromeTargetManager.ts:400` explicitly sends the owning resume; the
evidence does not convict a line in that public version or public Steel source.

Independent adversarial review approved provider escalation and rejected a
claim of a confirmed hosted hidden-owner wait or a completed fix. The remaining
discriminator is provider-side attachment/parent/session IDs, wait flags,
throttle ownership, and matching resume traffic, followed by releasing only
the responsible owner while the provider stays live. The original pending
POST must arrive once with isolation preserved and the unchanged assertion
passing. That information is outside the observed client interface.

## Solution

No production fix or deployment. Persisted the standalone raw-CDP diagnostic
above so a fresh checkout can reproduce the boundary with the documented
dependencies and Steel credentials. It creates only synthetic content in one
fresh owned session and verifies native release on all normal exception paths.
It is a manually invoked provider diagnostic, not permanent deploy regression
coverage or a substitute for an owning-boundary blackbox when a fix is found.

The controlled HTTPS endpoint, exact browser control, and local owning-wait
fail/pass now exist. The remaining proof requires the hosted controller's
owning-session traffic and a provider-side correction that makes the unchanged
isolated-popup assertion pass. Do not rewrite third-party forms to grant opener
access, resubmit a pending POST, or hide this failure with a provider fallback.

A sanitized public-provider report has been prepared privately under
`.context/rca-915ab997/public-issue-body-final.txt`, SHA-256
`d0a411f257517b4894245757f784097f54a092d4f8da24872cc27883a581c629`.
External posting was proposed as approval `STEEL-REPORT-01` but was not
authorized or performed before the user requested archival and stopping.
The prepared report contains no original user transcript, identifiers,
credentials, flight details or attachments. The report requests the missing
owning-session evidence rather than claiming the suspected mechanism as fact.

No verified Rose-side fix was found; this does not establish that every client
remedy is impossible. A pre-creation tab-aware attachment experiment and a
different Steel region were not tested. A deliberate provider migration would
require preserving authentication and booking semantics and proving the same
isolated POST behavior; it is not an implemented recovery path. Future work
should start from these evidence limits rather than repeat the completed
controls or treat the local injected-owner proof as the hosted root cause.

Golden reference: OpenClaw
`openclaw/extensions/browser/src/browser/cdp-page-session.ts:98` verifies
navigation from committed main-frame URL and loader ID. Its
`pw-session-connection.ts:364` observes newly created pages and its
`pw-session.isolated-context.chromium.test.ts:82` tests window.open isolation.
The diagnostic converges on its committed-frame evidence; that reference does
not itself prove POST-popup handling works on this Steel build. Searches in
`claude-code-src`, `codex`, and `hermes-agent` found no equivalent POST-popup
repair to adopt.

At 10k agents this work adds no runtime state, polling, connections or shared
contention. Only an explicit provider diagnostic invocation allocates a provider
session; the local owner proof allocates none. Native status readbacks are
recorded in `.context/rca-915ab997/final-provider-cleanup.json` for all 16 exact
investigation-owned sessions. No user session or profile was altered.

## Human feedback

After the initial open findings, the user said "well /rca it", requiring the
investigation to continue toward causal proof rather than ending with the
preliminary provider-boundary observation.

The user subsequently requested `/push` of this RCA so future runs retain the
investigation, then stopping. This closes the current work session, not the bug.

## Reusable lesson

Compare native popup startup and committed-frame evidence before blaming click alignment, and keep opener controls separate from production fixes.
