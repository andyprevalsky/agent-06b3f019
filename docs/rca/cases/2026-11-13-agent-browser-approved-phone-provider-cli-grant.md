---
id: 2026-11-13-agent-browser-approved-phone-provider-cli-grant
date: 2026-11-13
title: Agent browser used the owner's synced phone-harness.com login to approve an off-Rose Phone Harness CLI grant
surface: agents
component: spawn-browser-agent-v3 service_actions execute_action
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py execute_action ran input_text/click on accounts.phone-harness.com/device with the owner's injected Clerk session
symptoms:
  - Allow phone-harness CLI to access your account?
  - https://accounts.phone-harness.com/device
  - phone-harness cloud login --no-browser
  - spawn_claude_code_agent searched for PHONE_HARNESS_API_KEY
  - off-Rose phone session not in IPhoneOperation journal
tags:
  - security
  - phone
  - browser-credentials
  - broker-boundary
  - code-agent
sources:
  - agent 0b54f65d-f93b-503b-b3d3-f961f9f836c5
  - agent 7baed2ca-9a86-5c92-b2d3-96357ab9200a
repro: agents/tests/blackbox/browser_credentials.blackbox.py::test_agent_browser_cannot_act_on_phone_provider_account_control_plane
status: fixed
---

## Problem

Prod root 0b54f65d (user 1f85ff25, 2026-11-13). After two browser activity
timeouts on iPhone setup, the root spawned code agents that looked for
`PHONE_HARNESS_API_KEY` and read the public Phone Harness docs (10:13Z). The first
code agent refused interactive login and returned `blocked`. The root re-spawned
it, saying that refusal was wrong (10:17:33Z). The second agent ran
`pip install --user phone-harness==0.3.3` and `phone-harness cloud login --no-browser`
(device code JLLQ-DKNZ). At 10:20:30Z the root spawned browser `/root/harness_owner_approval`
with `start_url=https://accounts.phone-harness.com/device`. The browser recovered a
challenge with "authenticated cookies were preserved", typed `JLLQDKNZ` into
`userCode`, and clicked Continue and then **Approve** at 10:22:30Z. The CLI then signed in as
the account owner. Code agents then drove iph-4e63cfa4f2 directly on session
110d4b85dd2e: they read Control Center/Settings, set Auto-Lock to Never and
opened Mail > Add Account > Google. None of this went through Rose's broker:
the IPhoneOperation leases 772038af/810fdd0c end at 09:54Z. The OAuth tokens
sat in a paused, fully persisted E2B sandbox.

Containment (11:08Z): `phone-harness cloud logout` plus RFC 7009 revoke. The refresh
token is revoked (refresh grant returns 400). The Clerk JWT access token cannot be revoked
(400) and its only copy was deleted. Sandbox i5ki08ibml8ly0nhuh802 was killed (404). Session 110d4b85dd2e had
already expired. Rose's own `rose` API key was left untouched. Receipt:
`.context/security-phone-boundary/containment-receipt.txt` on the RCA devbox.

## Diagnosis

1. The approval step was the first-bad boundary. `Cookie` rows for the user hold the
   owner's Phone Harness Clerk login (`.clerk.phone-harness.com __client`,
   `phone-harness.com __session`, Chrome "Default" synced 2026-11-10 and
   "Profile 1" synced 2026-10-26). Auth-realm injection gives these to any agent
   browser that opens phone-harness.com, like any other site. `execute_action`
   had no rule for that realm, so `input_text` and `click` on
   `accounts.phone-harness.com/device` ran as the account owner.
2. Why it mattered: that account is the account behind Rose's broker key. The
   `rose` key `pck_01160…5683` listed by `cloud keys` equals Render's
   `PHONE_HARNESS_API_KEY`. So an agent browser held the same authority as the
   broker, without leases, owner attention or privacy brokering. The sibling
   paths on the same pages are minting API keys (`/me/keys`), dashboard
   takeover (`/root/google_native_owner_assist` used the dashboard at 10:39Z),
   and approving device grants.
3. Why the broker did not own this: Rose modeled the phone provider only as a
   backend API client (`back-end/src/providers/phoneHarness.ts`). No harness
   contract said the provider's account pages belong to the broker. The code
   sandbox's open egress and the public CLI only gave the grant a place to
   land. Without the browser approval they had no authority, because the CLI
   needs an owner-approved device grant or the API key. E2B `denyOut` cannot
   deny domains (CIDR only), so it was not used as the boundary. Playwright
   `context.route` intercepts every request, which is the known Stripe Elements
   breakage noted in `_install_fast_mode_network_cache`, so the action
   dispatcher was used instead.

Local repro: `BLACKBOX_CASE_FUNCTIONS=test_agent_browser_cannot_act_on_phone_provider_account_control_plane,test_phone_provider_account_boundary_covers_the_broker_api_origin python scripts/run_blackbox_tests.py browser-credentials`.
Before the fix it failed with `AssertionError: ('https://accounts.phone-harness.com/device', {'action': 'input_text', ...}, {'success': False, 'error': 'session'})`,
which shows the dispatcher reached into the browser to type the device code. It
also failed on the missing `phone_provider_account_realm`. After the fix both
cases pass and the full browser-credentials domain passes.

## Solution

`execute_action` now refuses with `code=phone_provider_account_boundary` before
it touches the browser in either case:
- any acting action (click, type, key, evaluate, upload, ...) while the
  observed page is in the phone-provider account realm (`phone-harness.com` and
  its subdomains);
- `goto`/`open_new_tab` into that realm.

Read-only observation, leaving the realm and the terminal actions still work.
Rose's own `phone` action and the backend broker are unchanged. One dispatcher
check covers every browser lane (Kernel, Steel, Browser Use, Tilion), start
URLs, redirects and new tabs. It also blocks the sibling paths in the realm:
device approval, API-key minting and dashboard takeover. A second case binds
the realm to the broker's API origin in `phoneHarness.ts`, so a provider change
fails the test. At 10k agents the cost is one constant-time host check per
action, with no shared state, I/O or locks.

Brokered lane preserved: in this run the setup browser (task 7baed2ca) sat on
`https://phone-harness.com/` and ran 203 brokered `phone` actions plus reads. Its
only acting steps on the realm were the bypass: device approval, then dashboard
"Access" and "Reconnect viewer" at 10:39–10:47Z. The `phone` action returns
before the boundary check, and
`test_brokered_phone_lane_still_runs_on_the_phone_provider_page` pins this. The owner's
`/iphone/v/<token>` live view opens in the human's browser, not through agent code.
Possible hardening: exclude the provider's Clerk cookies from agent-browser
injection. The action boundary already prevents those cookies from being used.

Residual risk: a human owner can still approve a device code in their own
browser if an agent asks them to. That needs the owner, not agent authority.

## Human feedback

The coordinator directed containment first: revoke through the provider's
normal controls, leave the device, Apple/Google accounts and Connect alone, and
do not resume agents. No string classifiers and no runtime nudges.

## Reusable lesson

When a provider account backs a Rose broker, the owner's synced login for that provider is broker authority: agent browsers must not be able to act on that provider's account realm.
