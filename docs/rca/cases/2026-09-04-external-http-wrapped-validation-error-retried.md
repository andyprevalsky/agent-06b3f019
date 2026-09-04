---
id: 2026-09-04-external-http-wrapped-validation-error-retried
date: 2026-09-04
title: Socket-time HTTP validation errors were retried after fetch wrapped them
surface: back-end
component: external-http
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/external-http/service.ts:executeExternalHttpRequest
symptoms:
  - DNS rebinding rejection is retried as a transport failure
  - a private resolved address loses its InvalidExternalHttpRequestError type
  - caller receives ExternalHttpRequestFailedError after multiple attempts
tags:
  - external-http
  - ssrf
  - dns-rebinding
  - retry
  - cause-chain
sources:
  - PR #1261
repro: back-end/src/tests/unit/external-http.test.ts:testWrappedValidationErrorDoesNotRetry
status: fixed
---

## Problem

Connection-time DNS validation correctly rejected private addresses, but
Undici/fetch could wrap that typed rejection in a transport `TypeError`. The
retry boundary inspected only the outer object, retried the deterministic
security rejection, and finally converted it into a generic transport failure.

## Diagnosis

Archive search found retry-boundary relatives but no exact cause-chain case. The
first bad boundary was the top-level `instanceof` classifier: the typed error
survived as `cause`, but classification discarded that chain.

## Solution

Known-error resolution now walks the bounded object cause chain with cycle
protection and returns the originating typed error. The request fails on the
first attempt and preserves the security classification. A unit regression
wraps `InvalidExternalHttpRequestError` exactly as fetch does and asserts one
call and the original type.

## Human feedback

The user required every review-discovered correctness gap to be cemented before deployment.

## Reusable lesson

At platform boundaries, classify and propagate typed failures through wrapper cause chains before applying generic retry policy.
