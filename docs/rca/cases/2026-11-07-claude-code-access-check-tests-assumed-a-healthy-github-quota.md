---
id: 2026-11-07-claude-code-access-check-tests-assumed-a-healthy-github-quota
date: 2026-11-07
title: Three live claude-code access-check blackbox tests failed with the typed GitHub rate-limit 429 whenever the shared GitHub quota was drained
surface: back-end
component: claude-code-session
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/claude-code.blackbox.ts asserted 403 GITHUB_ACCESS_DENIED (or 400/403/500) from the live GitHub visibility lookup; with the shared core quota drained the endpoint answers the typed 429 GITHUB_RATE_LIMITED that this branch introduced, where the earlier code answered an accidental denial
symptoms:
  - "Expected status 403, got 429: GitHub rate limit reached (primary, core); retry after ... code GITHUB_RATE_LIMITED"
  - "Expected 400/403/500 for github access check, got 429"
  - backend-coverage-blackbox failed blackbox:claude-code in both staged cycles, each time minutes after a cloud smoke began drawing on the same quota
tags:
  - github-rate-limit
  - blackbox
  - claude-code
sources:
  - PR #1744
repro: back-end `bash scripts/run-blackbox-tests.sh claude-code` (passes with a healthy quota); the 429 body shape is pinned against real GitHub responses by github-rate-limit.blackbox.ts and its fixtures
status: fixed
---

## Problem

The backend gate's claude-code domain failed 3 (then 2) access-check tests in two cycles. Gate: INTRODUCED (a test-contract gap exposed by this
branch's typed rate-limit answer); the product behaviour is the intended one.

## Diagnosis

The tests call the endpoint with a nonexistent repository and a real token, so their outcome depends on GitHub's availability. The
quota is shared by every run on the account, and the staged cycle starts a nine-member cloud smoke at the same moment as the backend
gate, which drains it. The 429 carries code, `reset_at` and `retry_after_seconds` and stops before E2B.

## Solution

The three tests accept the answer only in that exact typed shape (code, string `reset_at`, numeric `retry_after_seconds`); the boundary
test still requires zero E2B calls. A healthy quota still asserts the denial.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

A live-provider test that asserts a negative outcome must say what it expects when the provider is rate limited.
