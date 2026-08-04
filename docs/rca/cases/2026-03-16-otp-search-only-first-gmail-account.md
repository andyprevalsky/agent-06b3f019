---
id: 2026-03-16-otp-search-only-first-gmail-account
date: 2026-03-16
title: Email OTP lookup searched only the first connected Gmail account
surface: back-end
component: gmail-otp-fetch
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the Gmail OTP fetch path resolved a single (first) connected account instead of iterating every connected account for the user
symptoms:
  - OTP email never found for a user with more than one Gmail account connected
  - login/verification flow stalls waiting for a code that was delivered to a secondary inbox
  - transient Gmail network/5xx/rate-limit errors surfaced as "no OTP found"
tags:
  - gmail
  - otp
  - multi-account
  - retry
  - rate-limit
sources:
  - PR #217
repro: none-recorded
status: fixed
---

## Problem

Users with more than one connected Gmail account were missing OTPs: the code was
delivered to a secondary account, but the OTP fetch only ever inspected the first
connected account, so the flow behaved as if no code had arrived. Transient Gmail
failures (network errors, 5xx, rate limiting) produced the same
indistinguishable "no OTP" outcome because there was no retry.

## Diagnosis

The account-resolution step assumed one Gmail identity per user and short-circuited
on the first connected account, so the search space silently excluded every other
mailbox the user had authorized. Which inbox receives an OTP is decided by the
third-party site, not by us, so any single-account assumption is wrong by
construction the moment a user connects two accounts. A second, compounding cause:
the fetch had no backoff, so a rate-limited or briefly failing Gmail call was
reported as an empty result rather than as a retryable error — masking how often
the primary path actually failed.

## Solution

Fetch from _all_ connected Gmail accounts on every OTP lookup, in parallel, and
merge/sort the results, so delivery to any authorized mailbox is found. Added
exponential-backoff retry for transient errors (network failures, 5xx, rate
limits) that honors the `Retry-After` header on rate-limited responses. The same
change removes the class of "silent empty result" where a provider error was
indistinguishable from a genuine absence of mail.

## Human feedback

None recorded.

## Reusable lesson

When a lookup depends on which of a user's several connected accounts a third
party chose, search every connected account rather than the first — and make a
provider error retry rather than degrade into an empty result.
