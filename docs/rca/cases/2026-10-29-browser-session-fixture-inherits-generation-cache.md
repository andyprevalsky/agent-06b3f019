---
id: 2026-10-29-browser-session-fixture-inherits-generation-cache
date: 2026-10-29
title: Reused browser session fixtures inherit another generation pointer
surface: agents
component: browser-session-lifetime-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Synthetic session fixture reads a foreign process-global generation pointer before its lifetime check
symptoms:
  - reused_session_yields_before_provider_releases_it returns generation_superseded
  - reused_session_with_time_left_keeps_stepping stops after one step
tags:
  - fixture
  - process-cache
  - generation-drain
  - browser-session
sources:
  - PR #1634
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_reused_session_lifetime_fixture_isolates_cached_generation
status: fixed
---

## Problem

The full agents run failed both reused-session lifetime controls, although the
unchanged standalone owning domain passed. A session expected to yield for its
expiring lifetime instead yielded for `generation_superseded`; a session with
time remaining stopped after one model step.

## Diagnosis

The synthetic fixture mocked browser state but left the real generation-pointer
reader and process cache unscoped. Generation drain runs before the session
lifetime check. Supplying a foreign cached queue reproduced both original
failures through their unchanged assertions. The original broad-run log did not
identify which prior case populated that cache, and no producer is claimed.

Archive searches covered the literal reused-session generation symptom,
session-deadline fixtures and process-cache isolation. Related deploy-drain
cases did not establish this exact fixture cause. Existing pause and approval
support fixtures already scope the same pointer dependency to their synthetic
activity environment.

## Solution

Scope and restore both cached pointer fields and the pointer reader in the
owning helper. Return the actual synthetic activity queue while retaining the
real generation-drain, worker-shutdown and session-lifetime logic. Register a
cache-poison regression that calls both original tests and asserts restoration
of the outer cache. Production behavior, assertions and timeouts are unchanged.

The permanent regression fails against the original helper with the reported
generation reason, then passes five consecutive times with the fixed helper.
The identical full owning command,
`cd agents && venv/bin/python scripts/run_blackbox_tests.py spawn-browser-agent-v3`,
passes in 141.1 seconds. Its pre-fix standalone pass in 140.0 seconds is retained
and is not represented as a deterministic standalone failure. Before/after
probes, the conditional regression and domain logs are preserved under
`.context/pr1634-session-lifetime-rca/`. Full aggregate coverage is separate.

## Human feedback

The user requested fixing the remaining deployment gates, with a treasury-only
skip. No permission to remove session-reuse assertions was given.

## Reusable lesson

Make synthetic activity fixtures own and restore generation-pointer state before
asserting behavior that occurs after the drain boundary.
