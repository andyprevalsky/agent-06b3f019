---
id: 2026-09-04-auth-options-blackboxes-entered-live-minting
date: 2026-09-04
title: Disabled-only auth-options blackboxes entered live minted-identity provisioning
surface: back-end
component: auth-options-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/auth-options.blackbox.ts disabled-only fixtures omitted any enabled credential that suppresses minted fallback
symptoms:
  - passwords last used over a year ago are excluded fails only when live provider credentials are loaded
  - disabled passkey is surfaced but marked disabled fails only when live provider credentials are loaded
  - AgentPhoneProvisioningError appears in password-age and disabled-passkey serialization tests
  - backend coverage makes unrelated Primitive and AgentPhone provisioning attempts
tags:
  - blackbox
  - auth-options
  - hermeticity
  - agentphone
  - live-provider
sources:
  - PR #1246
repro: back-end/src/tests/blackbox/auth-options.blackbox.ts
status: fixed
---

## Problem

The backend coverage gate failed the `passwords last used over a year ago are
excluded` blackbox with an `AgentPhoneProvisioningError`. After that fixture was
isolated, a targeted rerun exposed the same error in `disabled passkey is
surfaced but marked disabled`. Both tests created only unusable credentials, so
auth-options correctly entered the minted-identity fallback. In deploy, loaded
provider credentials turned that incidental fallback into live Primitive and
AgentPhone requests; AgentPhone number creation timed out and the new
fail-closed reconciliation contract surfaced the error.

## Diagnosis

Archive searches for `agentphone auth options timeout`, `blackbox fetch mock
agentphone provisioning`, and `minted identity fallback reconciliation` found
the new ambiguous-write RCA and the older unmocked-Stripe hermeticity case. The
production error classification behaved correctly. The first bad boundary was
the blackbox fixtures: they wanted to test filtering or serialization of
unusable credential rows but did not provide an independent enabled credential
to keep the request out of an unrelated provider-provisioning branch. Ambient
deploy secrets therefore changed the tests' side effects and results.

## Solution

The stale-password case now creates an enabled passkey for the same realm, and
the disabled-passkey case adds a distinct enabled passkey. Those credentials
suppress minted fallback without changing the rows or assertions under test,
so both cases deterministically exercise their intended behavior and cannot
contact Primitive or AgentPhone. The standard auth-options blackbox remains the
checked-in regression and runs under the same secret-bearing deploy harness
that exposed the gap.

## Human feedback

The user required the isolation fix to be finished and deployed without leaving
review or verification gaps.

## Reusable lesson

Give a focused auth-options fixture an independent usable credential when provider fallback is outside its assertion, so ambient live secrets cannot expand the test's side effects.
