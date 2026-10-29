---
id: 2026-10-28-rose-loopback-inherited-transport-mock
date: 2026-10-28
title: Rose loopback test inherited the previous test's transport mock
surface: agents
component: rose-blackbox
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Real loopback fixture invoked HTTP while the prior test's global mock handler remained active
symptoms:
  - rose_local_loopback_no_fallback rejected its own loopback URL
  - loopback URL rejected by inherited mock handler
tags:
  - loopback
  - transport
  - test-isolation
sources:
  - PR #1634
repro: agents/tests/blackbox/rose.blackbox.py
status: fixed
---

## Problem

The registered Rose domain failed when an owned loopback request reached another test’s mock.

## Diagnosis

The production Ultra model regression installed a transport handler before the
real loopback test ran. That handler rejected the loopback endpoint instead of
letting the owned HTTP fixture answer.
## Solution

The test now temporarily restores real
transport only around its local request. Its exact local endpoint configuration
and assertion forbidding remote waterfall remain in place. The previous mock
is restored afterward; no production transport behavior changed.

Archive searches for the loopback assertion and global capture returned related
fixtures, but no confirmed recurrence of this boundary.

## Verification

The identical instrumented command from `agents`,
`venv/bin/python venv/bin/coverage run --parallel-mode scripts/run_blackbox_tests.py rose`,
failed before with 271 passing and two failing checks. After this repair and the
separate explicit-model fixture correction, all 273 checks passed. The other
failure was a stale expectation that production Ultra could use GPT-6 Sol;
that case now checks both pinned production pools and a separate unpinned pool.

Logs are `.context/rose-blackbox-rca-20261028/before.log` and `after.log` on the
investigating machine. The original complete coverage run remains failed; this
focused result is not represented as a successful full coverage run.

## Human feedback

The user requested fixes in PR1634 and completion of deployment. No permission to remove the local-loopback assertion was given.

## Reusable lesson

Tests that intentionally contact an owned local server must scope transport
mock state explicitly. A preceding test's response handler is not a network
policy for the next test.
