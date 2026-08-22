---
id: 2026-08-19-browser-native-ui-observable-but-not-actionable
date: 2026-08-19
title: Chrome's native passkey modal wedged the browser agent because every action channel is page-scoped
surface: agents
component: browser-agent-input-channel
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: service_actions.py::press_key historically sent only Playwright/CDP page input even though Kernel's display screenshot exposed browser-process UI; once Chrome opened its native passkey sheet, no available action channel could reach the surface the agent could see
symptoms:
  - "There aren't any passkeys for amazon.com.mx on this device"
  - "No passkeys available"
  - "⚠️ [passkey] WebAuthn environment was reset; rebuilding it"
  - "Browser agent requested user authentication assistance"
  - "Action press_key successful"
tags:
  - browser-agent
  - passkey
  - webauthn
  - kernel
  - native-dialog
  - observability
sources:
  - agent e36c8759-bc6b-473a-a817-5b9c3a804acf
  - agent 29d7648d-d3cc-4f62-82cc-569a41c10a19
  - agent 58cd1525-acc0-4bf7-9a96-388398354d08 (local benchmark)
  - agent dc752b5e-89dc-4dbe-ae4b-26bede7dc89b (local benchmark)
repro: .context/repro_native_dialog.py
status: open
---

## Problem

Prod agent `e36c8759-bc6b-473a-a817-5b9c3a804acf` ("Buy me something for < 5$
from amazon, u pick") spawned a browser agent that reached
`https://www.amazon.com.mx/ap/signin`, clicked **Iniciar sesión con una clave de
acceso** ("sign in with a passkey"), and then wedged for 2m44s behind Chrome's
own native modal:

> **No passkeys available** — There aren't any passkeys for amazon.com.mx on
> this device

It executed 17 actions against a page that never changed — click `#signInSubmit`,
press Enter, press Escape, retype the password four times — every one of which
logged `Action ... successful`. At 20:14:01 it gave up with
`request_user_assistance_for_authentication`.

Runtime evidence (ClickHouse `observability.fly_logs`, Fly worker):

- `20:10:39.962` `[overlay-suppress] WebAuthn native UI disabled` — once, at connect.
- `20:10:48.276` `[passkey] seeded 1 passkey credential(s)`, readback
  `expected_count=1 observed_count=1`.
- `⚠️ [passkey] WebAuthn environment was reset; rebuilding it` **13 times**
  between `20:11:02` and `20:13:03` — roughly once per agent step (~9s). Each was
  followed by a successful rebuild and readback, so suppression *was* re-armed
  every step.
- `20:11:17.5` click on the passkey button; next reset detected `20:11:22.29`.
- `20:12:36.708` explicit `screenshot` action; `20:12:45.997` `press_key`
  (Escape) — the model saw the modal and tried to close it.
- Prod DB: the user (`43c2f6ae-…`) holds an **enabled** passkey with
  `authRealm=amazon.com.mx`, `rpId=amazon.com.mx`.

## Diagnosis

Three separate facts compose into the wedge. Live validation changed the weight
of the original diagnosis: target-scoped WebAuthn state is a real defect and is
locally reproducible, but it is not sufficient to explain every chooser. The
missing browser-process input channel is the proven boundary that turns any
chooser occurrence into a permanent wedge.

**1. The agent could see the modal, but only through one narrow path.** Routine
per-step observation is DOM-only (`include_screenshot=False` throughout
`handler.py`), and CDP `Page.captureScreenshot`
(`agents/browser_tools/dom_service.py:1121-1138`) is provably blind to
browser-process UI. The explicit `screenshot` action is different: on Kernel it
returns the **full, uncropped display capture**
(`agents/domains/spawn_browser_agent_v3/service_actions.py:3172-3178` crops only
when `provider == "steel"`; Kernel path is
`back-end/src/providers/browser/kernelSessionIo.ts:83-86`). The prod behaviour
confirms it: screenshot at `20:12:36`, Escape at `20:12:45`.

**2. At incident time, nothing the agent could do reached a browser-process
modal.** Every action — click, type, `press_key` — went through Playwright over
`connect_over_cdp`, i.e. CDP `Input.dispatchKeyEvent`, page-scoped
(`agents/browser_tools/humanizer.py:828-852`). The provider `computer` API was
wired for `captureScreenshot` only. Screenshot in, nothing out. This is the
first bad boundary because the prod agent had already observed the modal and
selected the correct recovery action (Escape); the harness falsely delivered
that action to a layer Chrome had blocked.

**3. The suppression and credential cache had a separate target-lifetime
defect.** **Chrome's CDP virtual authenticator is target-scoped.**
`.context/repro_click_and_target_scope.py` reproduces the target-mismatch
signature in real Chrome: seed the authenticator on target A, run the ceremony
on target B, and

```
readback on target A (our health probe): OK (1 credential(s))
ceremony on target B                   : None      <- hung on the native modal
=> authenticator is TARGET-SCOPED; a healthy probe on A says nothing about B
```

That is consistent with the prod logging — `readback expected_count=1
observed_count=1` succeeded while Chrome told the user there were no passkeys.
It justified rebinding WebAuthn state to the focused target, but later live
verification disproved the stronger claim that this was the only cause.

`dom_service.py:645` is the **only** assignment to `self._webauthn_cdp`. It is
captured once at connect and never re-bound, while every other CDP consumer
re-resolves `agent_focus_target_id` live (`:544`, `:909`, `:1123`, `:1392`).
The recurring `WebAuthn environment was reset; rebuilding it` also exposed an
authenticator-lifetime failure: Chrome can invalidate an authenticator ID while
the target survives. The first local live run failed four browser starts with
CDP `-32602 Could not find a Virtual Authenticator matching the ID`, so reset
handling now discards, recreates, and reseeds that state.

In local agent `58cd1525-acc0-4bf7-9a96-388398354d08`, however, suppression and
one credential repeatedly read back healthy on focused target `613CB…` and the
native chooser still appeared. In `dc752b5e-89dc-4dbe-ae4b-26bede7dc89b`, the
same occurred on target `5B65…`. Therefore a healthy target-local readback is
not a proof that Chrome will avoid browser-process UI; the target fix reduces a
known failure mode but cannot be the sole safety mechanism.

Two sibling gaps fall out of the same shape: `inject_passkeys` returns at
`dom_service.py:932-933` when no passkey is held, and `handler.py:5113` returns
before even calling it — so a user with **no** passkey for the current site never
re-arms suppression for the entire session.

## Local reproduction

`\.context/repro_native_dialog.py` drives real desktop Chrome headful, three arms:

```
NO_PROXY='*' ../bogota/agents/venv/bin/python .context/repro_native_dialog.py
```

| arm | ceremony settles | page sees keys | password lands | CDP screenshot changes |
| --- | --- | --- | --- | --- |
| suppression armed + matching credential (control) | yes | `Escape,h,u,n,t,e,r,2` | `hhuunntteerr22` | no |
| suppression armed, **no** matching credential | yes | `Escape,h,u,n,t,e,r,2` | `hhuunntteerr22` | no |
| **suppression not armed (the incident)** | **no** | **`""`** | **`""`** | **no** |

The third arm reproduces every observed symptom: the page receives zero key
events, Escape does not dismiss the modal, typed text never lands, and the CDP
screenshot sha256 is byte-identical before and after the modal appears — while
every CDP call returns success.

The second arm is the decisive fix-validation: keeping suppression armed when
there is no matching credential makes the ceremony **fail fast** and leaves the
page fully interactive. It does not relocate the hang to the relying party's
timeout.

Two supporting artifacts:

- `.context/repro_suppression_invariant.py` — after the environment is reset,
  `inject_passkeys([])` issues **zero** CDP calls; suppression is never re-armed.
  This is the sibling defect (user holds no passkey for the site), not this
  incident.
- `.context/repro_click_and_target_scope.py` — proves the CDP virtual
  authenticator is target-scoped (healthy readback on target A while target B's
  ceremony hangs on the native modal), and that a CDP *mouse* click cannot
  dismiss the modal either: the page's own click listener fired `0 -> 0`, so
  while the modal is up the renderer receives neither keys nor mouse events.
  The live runs show this is a contributing failure mode, not a complete causal
  model of every chooser occurrence.
- `.context/repro_webauthn_nav.py` — same-origin *and* cross-origin
  `Page.navigate` on a single target both preserve the WebAuthn environment, so
  navigation alone is not the trigger; target change is.

## Solution

The fixture blocker is fixed, the exact prompt now has a reusable benchmark,
and the native-keyboard mitigation is live-validated. The case remains open
because native-UI suppression still permits chooser occurrences and provider
mouse/type input plus action post-conditions are not yet wired.

Implemented:

1. **Target-keyed WebAuthn state.** `DOMService` resolves the focused target at
   each use, tracks the authenticator by target, arms before ceremony-capable
   actions, and recreates/reseeds after Chrome's exact missing-authenticator-ID
   error. The third live trace also showed that reissuing `WebAuthn.enable` on a
   healthy target invalidated the old authenticator before every action, so a
   healthy target is now probed without re-enabling; enable/recreate happens
   only for a new or concretely reset environment. Tests cover target changes,
   invalidation, and the one-enable healthy path.
2. **Unconditional suppression.** A zero-credential site still receives
   `WebAuthn.enable {enableUI: false}` and a virtual authenticator, so absence of
   a matching passkey does not intentionally opt back into native UI.
3. **Kernel provider-level key input.** The backend exposes an owner-checked
   `POST /api/browser-session/:sessionId/computer/press-key` route backed by
   `kernelClient().browsers.computer.pressKey`. The browser action maps
   Playwright key names to provider key names, tries Kernel computer input
   first, logs the channel used, and falls back to the existing CDP path only
   when the provider explicitly reports that browser-process input is
   unsupported. Internal requests propagate the benchmark run user; a missing
   or foreign user is rejected before provider input. A timeout or lost response
   does **not** replay the key through CDP, because Kernel may already have
   executed a state-changing Enter.
4. **Reusable Tamy LIVE fixture.** `live-tamy-identity` retargets the production
   credential sync with `SEED_LOCAL_USER_ID`, upserts Tamy's `User` row before
   any user-scoped auth rows, refreshes her Amazon profiles/cookies/storage,
   passwords, passkeys, CookieBundles, and provider-session markers, and makes
   the task run as that same user. The exact verbatim prompt is catalogued as
   `browser-agent-amazon-mx-buy-under-5-usd`. That task runs in the exclusive
   shared-DB phase so its process-wide run-user override cannot race siblings,
   and it fails before launch unless both declared Amazon domains have
   injectable cookie bundles.

Still open:

1. **Explain or eliminate residual chooser creation.** Two focused-target live
   runs had healthy credential readback and still displayed Chrome's native
   sheet. Target rebinding is necessary but not a complete suppression model.
2. **Wire the remaining provider computer actions.** Keyboard Escape/Enter is
   enough for this chooser, but `clickMouse`, `typeText`, move, scroll, drag,
   batch, and clipboard remain unavailable to the agent. Other browser-process
   surfaces may require them.
3. **Give actions a post-condition.** A no-DOM/no-URL action must not be reported
   as successful without provider-level evidence. This remains the general fix
   for misleading no-op success.

## Exact live verification

Three exact local runs used the prompt `Buy me something for < 5$ from amazon,
u pick` and Tamy's identity:

- The first exposed stale virtual-authenticator IDs during browser startup and
  drove the reset/recreate/reseed fix.
- Agent `58cd1525-acc0-4bf7-9a96-388398354d08` reached Amazon.com sign-in with
  healthy target-local passkey readback, reproduced the native chooser, and
  timed out after 900 seconds because CDP Escape still could not dismiss it.
- Agent `dc752b5e-89dc-4dbe-ae4b-26bede7dc89b` selected a $4.99 FIXSMITH
  microfiber-cloth pack and reached checkout. When the chooser appeared, logs
  recorded `Pressed key through provider computer input`; the next agent step
  confirmed `Dialog dismissed`. A later provider-level Enter submitted Tamy's
  saved password and advanced to Amazon's mandatory second factor. The only
  offered factors were an iPhone push or WhatsApp to a number unavailable to the
  harness; email/SMS OTP was unavailable. No order was placed. The benchmark
  was stopped at 650 seconds when the auth guard proposed trying a different
  saved Amazon identity, which is outside the Tamy-fixture scope.

The third run therefore validates the native-key input mitigation but does not
pass the purchase evaluator: it drifted to Amazon.com rather than amazon.com.mx
and stopped at external device authentication. The new farthest proven boundary
is mandatory device 2FA, not an undismissable browser-process modal. The final
no-re-enable refinement above is supported by this run's exact reset sequence
and regression tests; it was not followed by another live purchase attempt
because Tamy's unavoidable device factor was already established.

Suppression is **not** a downgrade of passkey login and must not be removed:
with the credential on the right target, `enableUI:false` makes the ceremony
succeed *silently* (`{"ok": true}`); with no matching credential it fails fast
with `NotAllowedError` so the site falls back to password. The native chooser is
a dead end in a cloud browser in every case — it can only offer a local
authenticator (ours, which would not prompt) or a cross-device QR nobody can
scan.

## Human feedback

The user rejected the framing of "disable passkey popups" as a fix direction and
asked whether the popups are needed for login at all. Answer, proven by
`.context/repro_native_dialog.py`: they are not — `enableUI:false` with the
credential on the correct target signs silently (`{"ok": true}`), and with no
matching credential it rejects immediately with `NotAllowedError` so the site
falls back to password. Do not propose removing suppression, and do not describe
suppression as trading away passkey login.

The user also pushed for the agent to be able to act on native UI **by default**
rather than relying on suppression holding. That is proposal 3 (wire the provider
`computer` input API) and it should not be dropped in favour of the narrower
target-binding fix alone. Provider keyboard input is now implemented and was
used to dismiss the exact live chooser; the rest of the computer API remains
open.

The user also rejected a one-off local identity substitution and asked for
Tamy's account to be seeded as a reusable LIVE fixture. That became
`live-tamy-identity`, and the exact benchmark now derives both its seed target
and `BENCHMARK_RUN_USER_ID` from that fixture so the run cannot silently seed
one identity while executing as another.

## Reusable lesson

Never let an agent observe a surface it cannot act on: if a channel can render
blocking UI, the harness needs both an observation path and an input path at that
same layer, plus a post-condition that refuses to report success when an action
produced no state change.
