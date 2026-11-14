---
id: 2026-11-11-portrait-route-prover-rejected-documented-launch-shape-and-swallowed-reason
date: 2026-11-11
title: Portrait route prover rejected the documented Settings launch and the verify catch hid the reason
surface: back-end
component: iphone-setup-portrait
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/phonePortraitRoute.ts provePortraitRoute first-event check (args exactly {name:'Settings'}, result exactly 'Settings')
symptoms:
  - "phone_setup_verifier_unavailable"
  - "Portrait-lock verification has failed with phone_setup_verifier_unavailable"
  - "Phone native portrait route is unproven"
  - "Cloud iPhone result ERROR portrait_lock"
tags:
  - iphone
  - phone-setup
  - portrait-lock
  - swallowed-error
sources:
  - agent 09b554a3-7577-5ac0-9670-0f58dd668fa1 (lease d5337207, setup.verify cursors 25, 27, 69)
repro: back-end/src/tests/blackbox/iphone-control.portrait-route.cases.ts (production-shaped route cases + Photos/Safari errorCode assertion)
status: mitigated
---

## Problem

On 2026-11-11 the owner setup agent 09b554a3 connected a phone, verified the
Apple account, iCloud and passcode, but every `setup.verify` with
`verificationTarget=portrait_lock` (journal cursors 25, 27, 69) failed with
`phone_setup_verifier_unavailable`. Each failed in 0.4–1.3 s, before any
provider read, so no capture ever ran. The agent reported a verifier outage and
could not tell what to change. No Render log line existed for the failures.

## Diagnosis

1. `submitSetup` (`service.setup.ts`) ran `observePortrait` inside
   `try { } catch { result = null }`, and `finishSetup` turned every null into
   `phone_setup_verifier_unavailable`. The typed `IPhoneError` 409 reasons from
   `portraitSession` and the observation-expiry error were dropped without a
   log line.
2. A read-only prod query of the lease journal, replayed through an
   instrumented copy of `provePortraitRoute`, showed that all three verifies
   stopped at the first-event check. The agent used the
   `apps.launch {"name":"Settings","fresh":false}` shape from its own
   instructions (`agents/domains/spawn_browser_agent_v3/phone.py`), and the
   provider returned the bundle ID `com.apple.Preferences`. The prover accepted
   only `{name:'Settings'}` with result `'Settings'`, and only
   `input.text {s}` without the documented `delay`/`keystrokes`. It also
   refused the screen.text the instructions require after tapping Search. Real
   production routes could therefore never be proven. The blackbox fixture
   used the idealized shapes, so the suite stayed green.
3. Deepest cause: two contracts for one route (agent instructions and provider
   result vs. prover/fixture) drifted apart, and the swallow hid the
   divergence as a generic outage.

After the fix, the same prod journal gets past the launch check and fails on
genuine deviations: verify 25 started from a non-root Settings page, and
verify 69 had an `input.drag` mid-route. The agent now sees these as
`phone_portrait_route_unproven`.

## Solution

- `PhoneInteractionError` has an optional stable `code`. The portrait fences
  throw `phone_portrait_observation_changed`, `phone_portrait_session_not_ready`,
  `phone_portrait_route_unproven`, `phone_portrait_route_changed` and
  `phone_portrait_observation_expired`. `submitSetup` passes the code to
  `finishSetup` as the operation `errorCode` and logs every verify failure
  (`[iPhoneSetup] verify failed`, with IDs, target, code and a truncated
  message). Untyped verifier errors stay `phone_setup_verifier_unavailable`.
- `provePortraitRoute` accepts exactly the documented wire shapes: an optional
  `fresh: false` launch flag, the `com.apple.Preferences` bundle-ID result,
  `input.text` `delay`/`keystrokes` options, and read-only screen.text while the
  search field is focused. It still requires the same app, query, ordering,
  observed targets and Control Center proof. `fresh: true`, other args and
  other bundle IDs are still rejected.
- 10k agents: no new queries, channels or shared state. There is one log line
  per failed verify.

## Recurrence (2026-11-11, after PR #1935)

Production confirmed that the swallow is fixed. Agent 08923d50 (lease ef01c7a8) got its portrait verify at cursor 36 (18:36:38Z) back as `phone_portrait_route_unproven`, and Render logged `[iPhoneSetup] verify failed ... code=phone_portrait_route_unproven`. The route was still unproven because the agent relaunched Settings cold (`fresh: true`, cursors 14/44/54/75/93), and the prover accepted only `fresh: false`. A cold launch is stronger evidence of a clean start, and the root read is still required, so the prover now accepts any boolean `fresh`. A non-boolean value is still rejected (regression: the `production-cold` route cases). The same route also showed one typing attempt that did not register followed by a retype (cursors 18-22). The strict sequence still rejects that, and the agent now sees the typed reason telling it to restart from a new launch. Status stays `mitigated` until a live portrait verify succeeds.

## Recurrence 2 (2026-11-11, after PR #1947)

Agent acbb9d3c (lease 2a140be8, verify cursor 24) failed the route, not on an observed lock-OFF verdict. A replay against the live prover showed the break at cursor 10: the AssistiveTouch query typed with `keystrokes: false` did not register (the field was unchanged and showed no results). Across three live runs, `keystrokes: false` lost the query twice, and the immediate retype with `keystrokes: true` worked twice out of two. The delays were 14-29 s, so this is not a settle race. The same run then tapped the AssistiveTouch label (x 177) instead of the switch, and verified before the Control Center steps.

Fix (proof unchanged): `portraitRouteVerdict` reports the first breaking cursor, its stage and the next expected native step. It is stored as `operation.result.portraitRoute` on the failed verify and logged. PHONE_GUIDANCE now asks for `keystrokes: true` on that query and a tap on the switch, not the label (GROUNDED golden review portrait-route-guidance-2). The prover does not tolerate a retype: a lost query means restarting from a new launch. Regression: the "names the exact route break" cases in iphone-control.portrait-route.cases.ts. Replays of the real journals report stage `results` at cursors 10 and 19.

## Recurrence 3 (2026-11-12, after PR #1962)

Agent 902ff679 (lease 5544f520) completed the whole native route (cursors 33-48, with keystrokes true working). It was still rejected at the Control Center read: the live OCR is `Reduce` / `Interrup- -` (or `Interrup- ~`) / `tions`, and `portraitControlCenterAnchors` joined only a bare trailing hyphen. The agent also re-verified right after a failed verify, but any failed `setup.verify` row inside the window invalidates the route.

Fix: the anchor join tolerates a stray `-`/`~` after the line-break hyphen. A letter is still rejected, and the region and frame-mask checks are unchanged. `portraitRoute.next` now starts by saying that a failed verify ends the route and a new Settings launch is required. Regression: live Control Center OCR cases (unit plus API verify to `confirmed`). Replaying the real journal 33-48 now proves the route (`originalAssistiveTouch: on`).


## Recurrence 4 (2026-11-13, after PR #1972)

Agent 0b54f65d (leases 772038af and 810fdd0c) ran the portrait route for about two hours and never passed. A read-only replay of the prod journal against the prover showed three gaps between the prover and the real screens:

1. **The floating button cannot be observed (the main stall).** The route needs a tap on the floating AssistiveTouch button. It is an icon with no text, so the detail-page `screen.text` never contains a row for it, at `min_confidence` 0.3, 0.1 or 0 (lease 1 cursors 16, 33, 35; lease 2 cursors 31, 47, 48). Meanwhile PHONE_GUIDANCE said to tap observed centers and `next` gave only the x band. The agent's reasoning was "no floating icon in the OCR" and "the exact Y-coordinate is missing… never use blind coordinates". It verified early (cursor 17, stage `float`), then blocked portrait (cursor 36) and later deferred it with `user_constraint` (lease 2 cursor 58). The only taps that opened the menu were right-edge taps at (686,746) and (687,990). Agent 902ff679 found the button by guessing. Any tap in the band that missed the button broke the route at `menu`.
2. **A benign refocus broke the route.** Lease 2 cursors 21-23: after the agent tapped Search, the next read still showed the field unfocused (no keyboard). The agent tapped the same observed field again, at (138,1237), inside the Search box (189,1230,118x28). The prover rejects any tap at stage `query` (the reported break `query@23`).
3. **Real OCR broke the Touch value check.** The Touch page OCR returned `On >` with an ASCII `>` (lease 2 cursor 29). The prover accepted only `›`, so the route would have broken there next. Separately, a `min_confidence` 0.1 re-read (lease 2 cursor 48) was rejected only because its args were not 0.3.

Fix (the lock-On proof is unchanged: the menu, the Control Center anchors, the backend capture, the verify status and the lock tap are all still required):

- At stage `query`, a re-tap inside the observed Search box is accepted.
- `screen.text` with any `min_confidence` in [0,1] is accepted.
- The Touch value check accepts `›` or `>`.
- At stage `menu`, a read that still shows the AssistiveTouch detail page (and no menu) returns to `float` as a missed probe. A real menu read still wins.
- `NEXT_STEP.float` and PHONE_GUIDANCE now say that `screen.text` cannot see the textless button, name the right-edge band, and limit probing to three points, after which the agent reports the blocker (golden review `iphone-portrait-float-probe-1`).

Regression: the "2026-11-13 production journal" case in iphone-control.portrait-route.cases.ts replays sanitized real rows (fixture `iphone-portrait-route.prod-20261113.fixture.ts`). Before the fix it failed with `query@5` (the prod `query@23`). It passes after the fix. The negative cases still break: a tap outside the Search box, a probe that navigates away, a tap outside the band, and a malformed or out-of-range `min_confidence`.

Pre-fix repro (`npx tsx .context/rca-iphone-setup/run-case.ts "2026-11-13 production journal"` from `back-end/`): `FAIL … Refocusing the observed Search broke + 'query@5' - 'float@13'`. Post-fix: `PASS`. Full `bash scripts/run-blackbox-tests.sh iphone-control`: PASS.

10k agents: no new queries, state or channels. The prover is still bounded by its 64-event window.

Other causes found in the same run. They are outside this prover fix, so they are reported to the coordinator, not fixed here:

- Both phone browser agents were hard-killed by the browser activity's 30-minute StartToClose (08:50:48→09:20:49 and 09:40:19→10:10:20), in the middle of setup. The next spawn then failed with "Previous browser activity cleanup is unconfirmed".
- After those failures, the root used code agents to find and run the official Phone Harness CLI outside Rose. It got CLI credentials through an OAuth device approval that a browser agent completed. The native Google sign-in (Settings > Apps > Mail > Add Account) ran on that off-Rose session. That is why it is not in the Rose lease journal, and why `request_user_assistance_for_authentication` (which covers only the Rose phone and browser boundaries) was never reached. Inside Rose, the setup never reached a password screen: the Gmail launch returned HTTP 422 and the agent blocked.

## Human feedback

None recorded.

## Reusable lesson

Never collapse a typed precondition failure into a generic outage code, and
build proof-validator fixtures from the real provider and the agent's
documented wire shapes, not from idealized arguments.
