---
id: 2026-10-29-flash-subscriptions-escaped-root-scope
date: 2026-10-29
title: Flash compute subscription eligibility escaped the requested root and explore scope
surface: cross
component: rose-pool-registry
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Base Flash and browser pool registries enabled subscriptions for all call sites
symptoms:
  - complete_browser_use_auth_tokens_ignored failed
  - rose-browser-use reported 113 passed and 4 failed
  - Cerebras-only browser fixtures contacted a compute provider
tags:
  - flash
  - compute-tokens
  - scope
  - browser
sources:
  - PR #1634
  - commit e60ae44f3
repro: cd agents && venv/bin/coverage run --parallel-mode scripts/run_blackbox_tests.py rose-browser-use
status: fixed
---

## Problem

The requested Terra/Opus compute defaults apply to Flash root and explore. The earlier subscription change also enabled them in the base Flash and browser pools, altering chat/browser routing.

## Diagnosis

The full instrumented agents run failed four existing browser assertions: supplied tokens contacted providers that these call sites previously skipped. Both pool registries enabled subscriptions globally. Archive searches for `auth tokens ignored browser Cerebras` and `Flash subscriptions scope chat root explore` found related routing cases but no established recurrence of this scope boundary.

## Solution

Restore disabled subscription eligibility in the base TypeScript and Python Flash/browser pools. The existing Python call-scoped override alone enables it for plan_loop, execute_loop, and explore_agent. Retain Terra and Opus models and effort/speed handling in that override. Keep the original browser assertions unchanged; update the recently added global-subscription tests to enforce the narrower user contract.

## Validation

The original instrumented browser domain reported 113 passed and 4 failed. After correction the identical instrumented domain command reported 117 passed and zero failures. Logs: /var/tmp/rose-resume-agents-coverage.log and /var/tmp/rose-browser-scope-fixed-instrumented.log. The incomplete full run remains interrupted/failed; the focused pass does not replace full release coverage.

## Human feedback

The user specified new Flash defaults for root and explore, said to leave chat as is, and retained Sol 6.1 medium for coding. Opus 5.5 low was selected as the Claude alternate. No broader browser-routing change was requested.

## Reusable lesson

A role-specific routing policy belongs at the call boundary. Enabling an entire pool changes every consumer, including independent browser and chat entrypoints.
