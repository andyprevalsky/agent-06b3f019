---
id: 2026-07-19-codex-usage-limit-detector-missed-quota-wording
date: 2026-07-19
title: The codex usage-limit detector matched only two phrasings, so the funded-key fallback never fired on "Quota exceeded"
surface: back-end
component: codex-code-agent
classification: our-bug
problem_class: other
first_bad_boundary: 'codex `ws-server.mjs` usage-limit detector — matched only "usage limit" and "purchase more credits"'
symptoms:
  - '"Quota exceeded. Check your plan and billing details." does not trigger the funded-key fallback'
  - '"insufficient_quota" from the codex runtime is treated as a generic failure'
  - the codex code agent fails outright instead of falling back to the funded key
tags:
  - codex
  - quota
  - fallback
  - error-detection
  - string-matching
sources:
  - PR #807
repro: none-recorded
status: fixed
---

## Problem

The codex code agent's runtime fallback to the funded OpenAI key did not fire when
the provider reported exhaustion as "Quota exceeded. Check your plan and billing
details." or `insufficient_quota`; the run failed instead of switching keys. Found
during a deploy RCA and disclosed in the same PR as a bonus reliability fix.

## Diagnosis

`ws-server.mjs` decided "this is a usage-limit condition" by substring-matching two
literal phrasings — "usage limit" and "purchase more credits". The provider's
billing-exhaustion wording is not stable, so any other phrasing for the same
condition bypassed the detector and reached the generic failure path. The fragile
part is the design: a recovery decision keyed on the exact prose of an upstream
error message silently loses coverage whenever the upstream text changes.

## Solution

Widened the detector to also match "Quota exceeded. Check your plan and billing
details." and `insufficient_quota`, so the funded-key runtime fallback fires on
those wordings too. Unit-verified for the billing phrases and, importantly, against
disk-quota and rate-limit strings so the widened match does not produce false
positives; the source names no checked-in path for that verification.

## Human feedback

None recorded.

## Reusable lesson

When a recovery path is gated on matching an upstream error's prose, enumerate every
known phrasing and test the near-miss strings too — a missed synonym silently
disables the fallback.
