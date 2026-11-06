---
id: 2026-10-29-cdp-mouse-transport-test-unseeded-path
date: 2026-10-29
title: CDP mouse transport test randomly generated fewer samples than its stress precondition
surface: agents
component: browser-humanizer-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: transport fixture left synthesize_mouse_path RNG unseeded while asserting more than twenty samples
symptoms:
  - "browser_humanizer_cdp_mouse_transport_full_path"
  - "assert len(cdp.calls) > 20"
tags:
  - humanizer
  - test-fixture
  - random
sources:
  - PR #1627
  - commit d7e67eb38c3b21c5cd912c340c29e301e483f0e8
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_humanizer_cdp_mouse_transport_queues_full_path_before_drain
status: open
---

## Problem

Full AG coverage failed 123/124 at the transport test's more-than-20 queued-events
assertion. Original log is .context/test-runs/agents-coverage-20261029-183811-480581/spawn-browser-agent-v3.log.
The historical generated sample count and RNG seed were not retained.

## Diagnosis

The fixture patches module random.random, but production synthesize_mouse_path
creates its own random.Random when no RNG is supplied. The test therefore has
an uncontrolled path cardinality. A fixed finite seed audit found 19 valid samples
for seed 626, and 20 for seeds 2153/3339, at the exact fixture coordinates and motion
parameters. Running the exact original test with deterministic default seed626
fails at its original assertion. The historical seed is still UNKNOWN; this is
mechanism proof, not recovery of its random state.

## Solution

Temporary test-only patch injects Random(0) into the real production path
generator using a fixture-local partial. Its 33 samples meet the test's intended
transport stress precondition. Every original assertion, timeout, and threshold
is unchanged; no fake path, production change, or retry is introduced.

Patch SHA256 66d45d25098096e9758615a3258add0e682fae32c294db3cb18d60fb21dceeaa
and exact commands/source hashes are retained under
/var/tmp/deploy-1627/humanizer-cdp-rca. Exact before fails; corrected owning test
passes five times. Three unchanged generator controls for nonlinear geometry, velocity
and duration also pass five times. No provider/model/live browser calls were made.
Independent review, source-owner integration and full AG validation remain
required; status is OPEN until those finish.

## Human feedback

Keep the original assertion and budgets, diagnose randomness versus runtime,
prepare temporary copies only, and preserve the failing full-gate receipt.
Freedom remains unchanged.

## Reusable lesson

When a transport test requires a large valid input, fix that input's random
seed explicitly and keep production distribution tests separate and unchanged.
