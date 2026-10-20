---
id: 2026-10-14-google-password-readiness-partitioned-by-rose-account
date: 2026-10-14
title: Google password inventory was empty for the task owner while Apple imports belonged to another Rose account
surface: cross
component: browser-credential-account-readiness
classification: unresolved
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Observed candidate is task-owner credential inventory; the missing same-owner Apple import and original Google session loss have no demonstrated upstream ingestion cause
symptoms:
  - Passwords none in Auth Options for google.com
  - password_refs_count 0 and attemptable_password_count 0
  - Couldn't find this account
  - Requesting User Assistance for google.com Login
  - Saved password none before Google password challenge
tags:
  - browser-auth
  - google-calendar
  - password-inventory
  - user-isolation
  - apple-passwords
  - two-factor-authentication
sources:
  - agent 47a8ff5f-b40b-4e1b-8219-3cda65650836
  - commit b784977b0bf699c56bc67b063ae849a9cf5150fb
repro: none-recorded
status: open
---

## Problem

The user expected this agent to enter a saved Gmail password while checking
Tamara's shared calendar, and asked whether authentication benchmarks cover that
behavior and whether assistance should support phone/app approval.

The complete 116-message transcript, 35 original archived LLM dumps, retained
worker/backend logs and secret-free production credential metadata were read.
The task requested andy@roselabs.ai and prohibited signing into Tamara's account.
At 17:35:19.153841 UTC the worker logged password_refs_count=0 and
attemptable_password_count=0. Native tool results in the original browser dumps
reported inventory_status=available, auth_realm=google.com, Passwords none,
Passkey none and no connected email OTP inboxes. These are actual tool results,
not an inference from the model's reasoning. A cookie bundle was applied at
startup, but Google's account chooser showed the remembered accounts signed out.

Google returned Couldn't find this account after andy@roselabs.ai was entered.
The browser tried remembered accounts, returned to a@roselabs.ai's password
screen, and requested assistance at 17:37:50.999. There was no password typing
action and no observed second-factor challenge. Dump 56ee222832d7 contains the
final password DOM and the assistance action. The original root remained ACTIVE
awaiting assistance; its session, credentials and task were not changed here.

Database and runtime logs agree that the task owner is the Rose account with
email andy@roselabs.ai. It has 552 Chrome-source password records, no Apple or
Atlas password records, and no Google password with username a@roselabs.ai.
Its 22 Google-realm rows contain 21 enabled stale/unset passwords and one recent
Remote Desktop credential already disabled at 17:24:48 after an earlier failed
attempt. The other Rose account, with email a@roselabs.ai, has 178 Apple-source
password records and two enabled, recent Google password records for
a@roselabs.ai. Secret values and encrypted payloads were not printed or copied.

The comparison initially used the hardcoded development user from the log CLI.
That account is not this agent's owner. After discovering the runtime user ID,
every incident credential query was repeated against the actual owner; both
accounts were compared explicitly. Tree diagnostics also returned zero agents,
so its HEALTHY banner was discarded and the raw root transcript was retrieved.

## Diagnosis

Critical path: authenticated Rose identity -> task owner -> user-scoped saved
credential lookup -> realm/freshness/disabled filtering -> browser secret refs
and auth options -> Google sign-in -> human assistance.

The evidence establishes the browser had no usable password reference, rather
than proving it ignored an available password. authOptionsStore.ts scopes
findBrowserPasswords to userId; authOptions.ts scopes by realm and requires use
within one year. A password under another Rose user is intentionally excluded.
Why the active account lacks Apple imports has not been reconstructed from its
original import event. Neither a duplicate-account creation bug nor an ingestion
failure is established. Likewise the applied cookie bundle's server-side
rejection is not diagnosed. The different requested Google identifier and the
browser's attempts at other remembered accounts are additional observations,
not a proven password-entry defect or a model-intelligence classification.

Archive searches: Saved password: none request_user_assistance_for_authentication
google.com; Gmail login password account chooser expired session 2FA; passwords
different user account Apple Passwords. Cases
2026-10-13-realm-transition-retained-stale-auth-context and
2026-10-12-cookie-bundle-ranking-used-sso-recency were read. This is a relative,
not a proven recurrence: the captured realm is correctly google.com and the
inventory is available, unlike the stale-realm incident.

Supporting local replay used the existing getAuthOptions service with synthetic
password values and captured account partition/credential metadata in local
Postgres. Command, run from back-end:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/victoria TRACE_ARCHIVE_BACKEND=local BENCHMARK_DISABLE_SAVED_BROWSER_AUTH=false BENCHMARK_ANON_STEEL_PROFILE=false node --import tsx ../.context/rca-gmail-47a8ff5f/replay-password-owner.mts
```

Observed in 122ms: PRE-IMPORT FAIL: Expected an enabled a@roselabs.ai saved
password for the task owner; got 0. The other synthetic user had two enabled
matching records. Importing synthetic equivalents for the task owner made the
unchanged readiness assertion find two records. This is an account-readiness
control, not a production fix, a live Google sign-in, an unchanged benchmark
outcome, or a closed incident RCA. The private scratch replay is not a permanent
regression and does not satisfy the completed-RCA hard gate.

The existing auth-options blackbox suite also ran against local Postgres:
the same environment prefix followed by
node --import tsx src/tests/blackbox/auth-options.blackbox.ts.
Result: 17 passed, 0 failed, including Chromium/Unix timestamp freshness and
disabled credential behavior. No new passing test is claimed as proof of the
original task outcome.

An independent adversarial review accepted these evidence and completion limits,
confirmed the coverage audit, and rejected attributing this password stop to
2FA: no second-factor challenge occurred. The original metadata substring
query also returns one Okta URL with /app/google/; Google-realm counts exclude it.

## Solution

No production code, prompt, schema, benchmark, account or credential was changed.
The case remains open pending original import/identity evidence and actual
same-owner credential repair followed by verification through the Rose harness.
The existing Apple Passwords & Passkeys import uploads using the active access
token (mac-app/main/domains/passkey-import/service.ts). The immediate supported
remedy is to import the intended credentials while signed into the Rose account
running the task, or intentionally use the Rose account already holding them.
Do not automatically share/copy credentials between user IDs.

Benchmark audit: 29 hosted auth tasks across 28 Rose Shop scenarios already
measure actual saved-password attempts, retrying saved logins, password followed
by emailed 2FA, named-account selection, human sign-in/resume and decline.
browser-auth-saved-password-retry checks the site's attempt ledger for every
saved login and requires a password session; browser-auth-password-email-2fa
requires a password_email_2fa session. browser-auth-email-otp reads a Rose Shop
code from Gmail; it does not sign into Gmail. google-oauth is explicitly an
in-memory demo with no Google requests and zero browser sessions.

No Google browser sign-in, external-device push approval, number matching or
TOTP scenario was found. The assistance API lists manual_step/manual_otp modes,
but the browser action has no parameters and hardcodes live_view; backend and
frontend independently display generic Sign in to google.com text. A separate
feature should carry page-grounded challenge instructions through the existing
assistance request and UI, preserve the same browser session, and resume only
after completion with authentication rechecked. Cover password acceptance ->
external device approval -> resumed task, decline and expired challenge, plus
controlled Google sign-in. These are proposed requirements, not implemented or
benchmarked capabilities; prompt/schema/benchmark changes need their concrete
diffs reviewed under the repo's approval rules.

Follow-up: the user authorized the external-app benchmark. Its local addition
exposed an independent form-only handoff contract defect, recorded in
2026-10-14-auth-handoff-rewound-pending-verification. The unchanged new benchmark
failed with two requests and passed after preserving the current verification
step. That fix does not repair this original task's credential ownership or
prove its Google login outcome; the original incident remains open.

The recorded saved-password-retry attempt on October 13 at 05:04:06 UTC passed.
That synthetic-fixture pass does not certify this production account's password
imports. Auth tasks are also path-selected, history-qualified deploy extras,
not an unconditional category floor (select_predeploy_benches.py).

At 10,000 agents, retain indexed user/realm credential isolation and the existing
per-agent request/signal lifecycle. No global credential-sharing layer, polling,
channel or runtime hot-path change was introduced. No prompt fix was selected,
so the prompt abstraction climb and golden-reference repair comparison are not
applicable to a landed change.

## Human feedback

The user expected saved Gmail password entry, asked whether existing auth
benchmarks guarantee it, and asked about Gmail sign-in and approving a prompt
in an app. They instructed the investigation to continue. No implementation
approval, credential-sharing authorization, or rejection was recorded.

## Reusable lesson

Bind credential-readiness evidence to the actual task owner's user ID before blaming browser behavior, and distinguish emailed OTP coverage from external-device approval and real identity-provider sign-in.
