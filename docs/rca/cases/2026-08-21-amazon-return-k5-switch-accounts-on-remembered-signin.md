---
id: 2026-08-21-amazon-return-k5-switch-accounts-on-remembered-signin
date: 2026-08-21
title: Amazon return k=5 agents clicked Switch accounts on remembered-password interstitial and never reached write_lock
surface: agents
component: amazon-auth-interstitial
classification: our-bug
problem_class: other
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_crypto.py auth-options guidance — no rule forbidding Switch accounts when remembered identity matches saved username
symptoms:
  - 'Expected attention kind write_lock, observed auth_assistance'
  - 'Expected write_lock attention request (to ignore) but none was triggered'
  - 'Clicking <a "Switch accounts">'
  - 'Updating saved credential state before waiting for user authentication assistance'
tags:
  - browser-agent
  - amazon-return
  - auth-assistance
  - switch-accounts
  - concurrency
sources:
  - agent 4789b9f3-f674-4bda-b979-f833747f0761
  - agent fbc36706-4093-4bb4-a457-d4a8f486e62b
  - memory:agents/benchmarks/runs/20260821_225850_browser-amazon-return.json
repro: pending — owning-boundary prompt/policy repro not yet cemented
status: open
---

## Problem

Local `browser-amazon-return` k=5 run `9568e708-4f30-4dee-9dff-3eded2957eef`
passed 3/5. Agent `4789b9f3-f674-4bda-b979-f833747f0761` failed:

`Expected attention kind write_lock, observed auth_assistance | Expected
write_lock attention request (to ignore) but none was triggered`

(`approvals_triggered=0`).

## Diagnosis

All five agents initially hit Amazon `ap/signin` with `max_auth_age=0` en route
to order history. Passers completed `POST /ap/signin/start` → `your-orders`.
Failer `4789b9f3` step-1 a11y showed remembered Andy Prevalsky + password +
**Switch accounts**; agent clicked Switch accounts, typed password, landed on
blank CVF `/ap/cvf/request` ("Authentication required"), then
`request_user_assistance_for_authentication`.

Sibling `fbc36706` made the same early Switch-accounts mistake, then recovered
to orders/write-lock (failed separately on password humanize ERROR).

Same CookieBundle injected across five concurrent Kernel profiles; passers
were the earlier-started agents. Concurrency is a likely contributor; not
fully isolated with k=1 vs k=5 A/B yet.

Proposed first-bad boundary for the *agent-owned* half: auth-options guidance
in `service_crypto.py` does not forbid Switch accounts when the remembered
identity matches the saved username — so the LLM treats Switch accounts as a
valid next click.

## Solution

Pending HARNESS_FIX_DECISION: add explicit auth-options instruction — when a
remembered account matches the saved site username/email, do not click Switch
accounts / Use a different account; sign in on that identity (passkey first,
then matching password).

Do not loosen the evaluator to accept `auth_assistance` as success.

## Human feedback

None recorded.

## Reusable lesson

On remembered-account sign-in interstitials, Switch accounts is usually the
wrong move when the shown identity already matches saved credentials; treat it
as an anti-pattern in auth guidance before diagnosing cookie absence.
