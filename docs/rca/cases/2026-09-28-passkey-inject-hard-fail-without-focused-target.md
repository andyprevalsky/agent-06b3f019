---
id: 2026-09-28-passkey-inject-hard-fail-without-focused-target
date: 2026-09-28
title: Passkey inject hard-fails when focus is briefly missing after navigation
surface: agents
component: browser-tools-dom-service-passkeys
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/dom_service.py::inject_passkeys — raises RuntimeError when agent_focus_target_id is missing while ensure_browser_overlays_suppressed soft-fails the same condition
symptoms:
  - "No focused browser target is available for passkey injection"
  - "Failed during: goto"
  - spawn_browser_agent toolStatus ERROR title Task Failed
  - browser_error_type RuntimeError
tags:
  - passkey
  - browser
  - cdp
  - focus
  - steel
sources:
  - agent a890a362-9775-410c-beb0-c251cd511845
repro: agents/tests/blackbox/browser_credentials.blackbox.py::test_passkey_inject_without_focused_target_retains_held_keys
status: fixed
---

## Problem

Prod agent `a890a362-9775-410c-beb0-c251cd511845` browser task
`9a497ffb-4e4c-59e3-8dc6-9b6e33d98547` died after a successful Amazon orders
goto with:

```
browser_error_message: No focused browser target is available for passkey injection
browser_error_context: Failed during: goto: {"action": "goto", ...}
browser_error_type: RuntimeError
```

A sibling browser on the same root failed later with
`BrowserStateRequestEvent` handler-returning-None during goto (CDP dead /
recovery budget), after the first kill and credential-classifier churn.

## Diagnosis

Archive searches (`No focused browser target passkey`, `CDP still not connected`,
`BrowserStateRequestEvent handler non-None`) found relatives
(`2026-08-22-stdlib-logger-kwargs-crash-passkey-target-follow`,
`2026-08-19-browser-native-ui-observable-but-not-actionable`) but not this
exact hard-raise-on-missing-focus contract. **Novel instance** of the broader
"injected browser state must survive target/CDP churn" class.

Critical path:

1. Browser completes a goto; `action_summary` last entry is that goto.
2. Next loop iteration calls `record_passkey_usage_once` →
   `sync_passkeys_onto_target` → `inject_passkeys` before every passkey
   counter poll (handler.py), because Kernel may reset WebAuthn per target.
3. After navigation/CDP reconnect, `agent_focus_target_id` can be briefly
   unset; `_live_cdp_session()` returns `(None, None)`.
4. `inject_passkeys` raised `RuntimeError` — uncaught at the step-start call
   site — outer `except` emits Task Failed with `Failed during: goto`.
5. Sibling path `ensure_browser_overlays_suppressed` already soft-failed the
   identical missing-focus condition (warn + return).

Step 5a ladder:

- Why 1: Task Failed with passkey RuntimeError.
- Why 2: inject_passkeys hard-raised on missing focus.
- Why 3: opportunistic re-seed treated a transient focus gap like a
  fatal contract break, while overlay arming already soft-failed.
  **Deepest owned cause.** Sibling: any post-nav / post-rotation re-arm of
  injected state (cookies already restored separately; passkeys were the
  surface that still aborted).

## Solution

`inject_passkeys` now matches overlay suppression: when no focused target,
log a warning, retain held passkeys in `_held_passkeys_by_credential_id`,
and return `0`. When focus returns, the next inject/sync seeds the retained
set onto the live target (re-init all injected state).

Cemented by
`test_passkey_inject_without_focused_target_retains_held_keys`
(pre-fix: RuntimeError; post-fix: seeded=0 then re-arm seeds on focus).

10k-agent behavior: O(1) warn + return per opportunistic re-seed with no
focus; no new fan-in, queries, or broadcasts.

## Human feedback

None recorded.

## Reusable lesson

Opportunistic re-arm of browser-injected state must soft-fail when the live
target is briefly missing — retain the held payload and re-seed when focus
returns; never abort the agent activity for a transient focus gap.
