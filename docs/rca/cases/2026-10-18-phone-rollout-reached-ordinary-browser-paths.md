---
id: 2026-10-18-phone-rollout-reached-ordinary-browser-paths
date: 2026-10-18
title: Phone discovery and fullscreen layout reached ordinary browser paths
surface: cross
component: cloud-phone-rollout-isolation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Phone discovery ran before checking trusted account rollout eligibility
symptoms:
  - Ordinary profile requests made an additional phone capability request
  - Ordinary browser decisions discovered a phone and included disabled phone state
  - Browser fullscreen moved the account rail without a visible phone
  - Dormant phone hooks attached visibility listeners
tags:
  - phone-harness
  - feature-gate
  - browser
  - isolation
sources:
  - commit cf79d55a66cd05946f3513ea0a41533663ee0c0d
  - task Cloud-only Phone Harness rollout isolation
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

The user conditioned approval of the next phone validation step on leaving main
trajectories unaffected. Account authorization existed at the phone API, but
the caller discovered capability for every profile and every browser decision.
An unauthorized response prevented phone use without preventing that extra
request or the disabled phone state in decision input. Ordinary browser
fullscreen also mounted the phone layout slot, and inactive phone hooks owned
document visibility listeners.

This is a local isolation defect, not evidence of a failed live task or model
reasoning. No paid model or live phone call was used for these reproductions.

## Diagnosis

Paths: existing user-settings response -> unconditional phone discovery -> root
profile; browser decision -> unconditional discovery -> model input; browser
fullscreen -> unconditional global-controls slot -> account rail relocation.
The first incorrect boundary is activating phone work before trusted rollout
eligibility or an actual phone-view candidate exists. An API denial is too late
to preserve the ordinary caller's request and input contract.

Archive searches: `phone disabled capability ordinary browser` and
`feature flag off prompt isolation global controls`. The existing
`2026-10-18-unused-browsers-entered-phone-lock` case is a relative: it fixed
backend lock acquisition for unused tasks, not discovery in the caller.
The fullscreen account-rail case fixed overlap while a phone is visible; this
follow-up restores ordinary browser placement while retaining that solution.
The SMS native-attention case establishes a separate privacy requirement:
historical native requests must stay protected if rollout is later disabled.

Prediction: an ordinary profile or browser call will invoke phone discovery,
and a plain fullscreen browser will acquire the global-controls slot.
Falsifier: the same ordinary calls emit no phone requests or model fields, and
the rail stays body-fixed while phone-specific positive controls still pass.

Executed test-first evidence is in `.context/phone-harness/`:

- `phone-off-profile-red.log`: existing profile helper called the phone endpoint.
- `phone-off-python-red.log`: ordinary decision called `observe_phone`.
- `rollout-red.log`: flag-off operation was admitted before the rollout guard.
- `phone-offpath-red.log`: mobile/desktop plain browsers moved the rail and
  the dormant overlay attached a visibility listener (three failures).
- `phone-offpath-attention-red.log`: absent native attention attached a listener.
- `phone-offpath-hidden-red.log`: activation after a dormant tab became hidden
  emitted a read before reconciling visibility.

The permanent tests live in the existing profile, browser, phone-control and
frontend blackbox suites. They are discovered by the normal deployment runners.
Exact commands and final results are recorded in the corresponding handoffs.

## Solution

Default-off `CLOUD_IPHONE_ENABLED` accepts only `1` or `true`, and must also pass
the existing persisted Andy account policy. Existing user-settings and browser
init/resume account reads append the optional `iphoneCapability: {enabled:true}`
marker only when eligible. Off and ineligible responses omit it entirely.
The helper is pure over the already-read account, without a new device query.

The root profile no longer discovers a phone. The browser loop observes it only
after receiving that trusted marker; an ordinary decision skips discovery and
heartbeat wrapping and omits phone state, guidance and tools. Phone action and
native-auth dispatch retain their eligibility checks. Enabled operation still
rechecks current backend authorization and physical ownership.

The frontend reserves the existing rail slot only while phone status is present.
Dormant overlay and attention hooks own no listener, timer or request. Activation
checks current document visibility synchronously. The same rail and browser
frame survive phone entry and exit; no duplicate control owner was introduced.

No on-path phone prompt was rewritten. Permanent golden hashes of full serialized
tools, system prompt and messages are generated from pre-phone `e62c44b75`, with
the existing challenge-recovery flag both on and off. They verify the ordinary
provider contract rather than just checking for absence of a phone keyword.

This does not remove SMS privacy enforcement for historical native attention.
Its existing bounded attention reads remain: bypassing them when rollout turns
off would allow private replies into ordinary messages. No universal zero-SQL
or end-to-end latency claim is made.

At 10,000 ordinary agents the change removes phone discovery and related
heartbeat/listener work. It adds a constant-time eligibility check to existing
account serialization. There is no new per-user channel, device query, registry,
background poll or shared lock on the ordinary path.

## Verification

Final normal agent suites passed 983 assertions: Rose 108, browser 771, profile
49, credentials 45 and capture 10. Log: `phone-off-python-final-normal2.log` and
`phone-off-python-adjacent.log`. The full managed result was collected and read.
The backend ten-domain run `1792364132-588923-7346` passed, followed by final
control 57/57 and the literal original red command 57/57 in
`1792364335-644811-21348`. It includes real init/resume serialization, zero extra
phone model queries there, and release after flag-off. Build, lint, provider 80,
layer checks and coverage-runner fixture registration passed.

Frontend owning gates pass 81/81, adjacent browser/admin gates 10/10,
and completion identity is preserved. The first two visual attempts overlapped
Vite reloads caused by source/test edits; they are not classified as product
remount failures. A subsequent frozen run retained the same iframe in all 15
native cases, including actual DOM identity and no removal observations.
The unchanged visual driver then passed all 15 native and 15 setup cases on
frozen source. There were zero page errors, zero setup writes, and the smallest
native phone image remained 155.17 pixels wide. The parent inspected the small
mobile password and verification states directly.

The first whole-frontend run overlapped the final hidden-tab source fix and
failed that new assertion. The unchanged command on frozen source passed all
170 files, 2887 tests, with 3 existing skips in 164.33 seconds. Coverage was
81.58/74.35/82.01/83.86 percent (statements/branches/functions/lines). Frozen
production build passed. Logs: `isolation-frontend-coverage-frozen.log`,
`isolation-frontend-build-frozen.log`, `isolation-native-visual-final.log`, and
`isolation-setup-visual-final.log`.

The rebuilt worker passed nonroot, network-disabled CLI, interpreter, import
and dependency checks. Its three production source hashes match the reviewed
tree; `isolation-worker-source-proof.log` records that comparison. No live
phone operation or deployment is claimed by this isolation verification.

The approved connectivity evaluator proposal remains separate. This case does
not change the task, its cost/time limit, or claim live sign-in/SMS verification.

## Human feedback

The user explicitly required: "just make it not affect the main trajectories
AT ALL, u can feature gate, then approved". Approval remains conditional on
isolation proof; no production environment was changed during this work.

## Reusable lesson

Gate optional resource discovery at its caller using trusted eligibility from
an existing response. A downstream authorization failure cannot undo extra
network work, altered model input, or unrelated UI layout changes.

## Enabled-path live validation

After the user-approved compatibility update, the original Settings task prompt
remained byte-identical (SHA256
`711a7f0f0e05db71042792751fbb7e1ad3c347285a943d0789a7cf93059363b8`).
The explicit isolated `CLOUD_IPHONE_ENABLED=1` run on source
`45343051ffa1790d864ec7e08c47340af1b49ea4` passed in 119.3 seconds:
`phone-connectivity-20261018t2307-r4`, Hub
`414778a7-aa50-4358-b406-9545ddbbcb7b`, root
`76660e5a-7c40-4771-ac73-dd5e2c69826f`.
Actual journal order was rejected `apps.launch/phone_setup_required`, successful
`setup.defer`, successful Settings `apps.launch`, successful `screen.text`.
The final reported heading was Paired Computers. This proves the enabled path
can respect the task's no-sign-in constraint and continue authorized work.
It does not establish Apple sign-in, Messages sync, or SMS capability.

The controller exited zero, phone/browser cleanup completed 2/2, and the owned
stack cleanup receipt is clean. Publication verified all 54 messages and
terminated browser recordings in a fresh browser. Durable evidence manifest:
`/opt/cursor/artifacts/rca_evidence/76660e5a-7c40-4771-ac73-dd5e2c69826f/manifest.json`.
The four earlier attempts remain in the ledger with their original outcomes;
the original 20:06:57 UTC slice clock was retained.
