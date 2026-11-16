---
id: 2026-11-07-static-browser-prompt-asserted-injected-cookies-without-session-state
date: 2026-11-07
title: The static browser system prompt said cookies were injected and the user was logged in, even for sessions with no cookies
surface: agents
component: rose-browser-use-system-prompt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/browser_use.py build_browser_use_system_prompt — Browser Rules always emitted "Browser cookies have been injected - assume the user is logged in until proven otherwise." The function receives only available_actions and cannot know session auth state, while the per-realm Auth Options inventory in tool observations reported "Steel session: none / Cookie bundles: none"
symptoms:
  - "Browser cookies have been injected - assume the user is logged in until proven otherwise."
  - "It looks like I lost the cookie, which means I don't have a login saved."
  - "[Steel]   Cookies: none, Fingerprint: no"
  - "fresh-cookie recovery was allowed (auth cookies not required)"
tags:
  - browser-auth
  - cookies
  - system-prompt
  - prompt-contract
  - opentable
  - browser-opentable-reservation
sources:
  - agent aef03f00-4645-4d71-af9c-894b554a7927
  - agent 7fee52e3-cdbb-4fd5-876c-7579655a7f31
  - fleet run 20261107-183106-905806
  - fleet run 20261107-183106-905859
  - benchmark run descend-failed-neverrun-20261106 epoch 18 jobs r001-j0004 and r002-j0016 (cluster H-57)
  - task browser-opentable-reservation
  - commit 4c9636f84d (base)
repro: agents/tests/blackbox/rose_browser_use.blackbox.py › test_browser_request_asserts_no_auth_state_its_inventory_contradicts
status: open
---

## Problem

`browser-opentable-reservation` copies r1 (agent aef03f00) and r2 (agent 7fee52e3)
in descend epoch 18 started their browser sessions with no auth state.
backend.log shows `[Steel]   Cookies: none, Fingerprint: no, localStorage: 3 origins`
(r1 18:42:47, r2 18:42:34 and again 18:49:33 after recovery). r2's worker.log
shows `"cookie_source": "none", "cookies_injected": false` on the realm transition.
The per-realm Auth Options inventory attached to each browser observation renders
as `Steel session: none` / `Cookie bundles: none` / `Passwords: none`.

The browser system prompt still told the model in Browser Rules:
"Browser cookies have been injected - assume the user is logged in until proven
otherwise." This is the only call to `build_browser_use_system_prompt`, through
`build_browser_use_messages` → `RoseClient.complete_browser_use`. In r2 the second
challenge recovery returned "fresh-cookie recovery was allowed (auth cookies not
required)". At booking/details the model then reasoned (archived message 100):
"It looks like I lost the cookie, which means I don't have a login saved." That
believes in a login cookie the session never had.

Both copies failed with "Timeout after 603s ... Expected one of ['write_lock']
attention requests". The failure chain is H-56/H-27: a 210 s challenge-recovery
exhaustion, then a sign-in iframe loop until the 600 s timeout.

## Diagnosis

Critical path: backend `injectUserData` (no CookieBundle → `Cookies: none`) →
worker realm credential state (`cookies_injected: false`) → `auth_context.auth_options`
inventory in the read_browser_state/action observation → model. In parallel, the
static `build_browser_use_system_prompt` text goes into system message 0 of every
browser call.

1. First bad data: the system message states a runtime fact ("cookies have been
   injected", "assume the user is logged in") with no source. The builder is
   intentionally static and globally cacheable, so it cannot reflect per-session
   or per-realm state. The same request carries the truthful inventory
   (`Cookie bundles: none`), so the model received contradictory auth state.
2. What made it possible: auth state has two independent sources in the browser
   context: a hard-coded claim and the derived inventory. Only the inventory follows
   the executing path (`build_auth_options_prompt_section` from the realm credential
   payload, re-derived after realm transitions and recovery). The shared authentication
   contract already says the truthful, state-independent version: "Cookie-based and
   existing Steel-session auth are applied automatically before you start."
3. Scope (descend fleet artifacts, all epochs on this box): 37 of 67 runs whose backend
   logged a session injection started with `Cookies: none`. They cover 14 tasks,
   including anti-bot-lulus-emerald-dress, browser-blue-bottle-challenge-recovery,
   anti-bot-ticketmaster-nyc, browser-hotel-booking, browser-instacart-grocery-order
   and browser-opentable-reservation. All 37 still received the claim. Across every
   archived browser reasoning text, only the r2 statement shows the misbelief.
   Thinking summaries are partial, so other occurrences are unobservable, not absent.

Causality for the failure: not causal. r1 had the same Cookies-none start and no
cookie misbelief. It made the same decision at the same step ("I need to sign in
to access my saved card", message 100 on booking/details) and failed the same
way. r2's sign-in happened at the same step, so the claim changed r2's stated
reasoning without changing the decision or the outcome. No replay was run: the
compute pool had about 1 usable token, and the r1/r2 comparison already
separates the variable deterministically. The defect is a harness-contract
inconsistency that misleads model belief. It is not the cause of the
opentable failure.

Step 5b climb: class C = "the static browser prompt asserts injected cookies regardless
of session state". C+1 = "LLM-visible claims about runtime auth state must come only
from the session's derived auth inventory, never from static text". That is coherent:
delete the static claim, because the inventory and the shared contract already
carry the truth. It also covers sibling realm transitions, fresh-cookie recovery
and cookie-less sessions. C+2 = "every static prompt in every harness must not assert
runtime state". That collapses into a cross-prompt audit with no single owning
boundary and no enumerated sibling instance: the other static Browser Rules
facts, such as full-screen browser and no address bar, are true by construction.
So C+1 is the deepest coherent class.

Golden reference: claude-code-src/src/constants/prompts.ts:643 computes
`Is directory a git repo: ${isGit ? 'Yes' : 'No'}` from the runtime instead of asserting it.
codex/codex-rs/core/src/context/world_state/environment.rs:30-40 (`EnvironmentsState`,
"Environment values visible to the model") derives model-visible environment state and
reports `EnvironmentStatus::Failed` rather than claiming availability. Both derive
runtime facts shown to the model from observed state. The fix converges: the only
auth-state statement left is Rose's derived per-realm inventory.

Local repro, red on 4c9636f84d:
`cd agents && source venv/bin/activate && TMPDIR=/var/tmp python scripts/run_blackbox_tests.py rose-browser-use`
→ `❌ browser_request_asserts_no_auth_state_its_inventory_contradicts: AssertionError:
system prompt asserts auth state the session inventory contradicts: 'cookies have been
injected'` (122 passed, 1 failed). The test sends a real `complete_browser_use`
request with the actual no-cookie opentable inventory observation and inspects the
messages given to the provider.

## Solution

On branch rca/h-57-20261107, the Browser Rules line "- Browser cookies have been
injected - assume the user is logged in until proven otherwise." is deleted from
`build_browser_use_system_prompt`. Nothing is added. The adjacent "Avoid login flows
unless the site forces you to login to complete your directed goal." stays, as do the
contract's priority "1. Existing Steel/cookie session" and "Cookie-based and existing
Steel-session auth are applied automatically before you start." Sessions that do have
cookies are still told cookie auth is applied and that they should avoid login
flows. Every session's actual state comes from its Auth Options inventory.

Regression (owning suite rose-browser-use, discovered by
`agents/scripts/run_blackbox_tests.py`):
`test_browser_request_asserts_no_auth_state_its_inventory_contradicts` passes 5/5
after the fix (123 passed). `test_phone_off_matches_prephone_bytes` was re-pinned
truthfully: only the system and messages hashes changed, in both
recover-from-challenge modes. The tools hashes are unchanged, and 4c9636f84d passes the
previous pins. prompt-invariants and prompts suites pass.

10k agents: one fewer static line in a globally cached prefix. No calls, state or
fan-in are added. The cached prefix changes once.

Status stays open until the prompt edit is approved and merged. It changes
LLM-visible text, so approval is snapshot-scoped.

## Human feedback

None recorded.

## Reusable lesson

Never let static prompt text assert per-session runtime state such as injected
cookies or a logged-in user. State it only from the derived inventory that the
executing path produces.
