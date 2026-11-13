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

## Human feedback

None recorded.

## Reusable lesson

Never collapse a typed precondition failure into a generic outage code, and
build proof-validator fixtures from the real provider and the agent's
documented wire shapes, not from idealized arguments.
