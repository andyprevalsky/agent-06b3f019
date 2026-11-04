---
id: 2026-10-28-browser-offline-fixture-missing-agent-speed
date: 2026-10-28
title: Offline browser activity fixtures omitted the persisted agent speed read
surface: harness
component: spawn-browser-agent-v3-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: _offline_activity_edges rejected the startup POST /api/fast-cache/agent-flag needed by resolve_agent_speed
symptoms:
  - Unexpected network attempts, including swallowed errors
  - finally_first_seal_diagnostics
  - finally_first_seal_resolution
  - OTP owning control forbids network
tags:
  - browser
  - speed
  - offline-fixture
sources:
  - commit fea71766a
  - task agents-coverage-20261028-204423-1102982
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

The integrated agents coverage run failed twelve OTP/cleanup controls and
two deploy-resume browser controls.
Each recorded an unexpected network attempt even though the expected browser
outcome was otherwise reached. The network denial assertion must remain strict.

## Diagnosis

The local isolated finally_first_seal_diagnostics control reproduced the exact
failure before edits. Instrumenting the resolver's client identified the first
request as POST /api/fast-cache/agent-flag with agentId agent-1. Browser startup
now resolves the spawning agent's stored speed once, before any model decision.
Both the shared offline fixture and deploy-resume backend modeled other
external edges but omitted this read.
The real resolver caught the transport denial and used its error default; the
fixture's exit assertion correctly exposed that swallowed attempt.

This is a fixture contract mismatch, not a redundant production request.
Removing the startup read or supplying a default speed would lose inheritance.
Archive searches used externalattempt and browser offline fixture network.
No exact recurrence was found; the October 4 browser-manager fixture case is a
related class, with a different missing response field and boundary.

## Solution

The shared fixture now supplies explicit stored speed at the exact backend
HTTP boundary while retaining denials for every other request. A registered
regression checks all three speeds inside real browser decisions, with the
legacy provider-fast flag set to the opposite value, and verifies one lookup.
Five consecutive focused runs pass all three values. The deploy-resume backend
also serves only configured agent rows; its existing rolling/cutover controls
now assert every old/new-worker decision retains the same stored speed.
The original step-count, session identity, billing, generation sealing and
zero-unexpected-request assertions remain unchanged.

Verification commands, run from agents/:
- venv/bin/python scripts/run_blackbox_tests.py spawn-browser-agent-v3
- venv/bin/python scripts/run_blackbox_tests.py deploy-resume-e2e

The first local browser-domain run launched from the repository root also
reported three file-relative checks unable to find domains/.../handler.py;
these are invocation artifacts, not the reported network failure. The isolated
finally-seal control separately reproduced the exact network rejection, and
the full verification uses the documented agents/ working directory.
The post-fix deploy-resume-e2e domain passed all four cases in 32.8 seconds.
The combined post-fix spawn-browser-agent-v3, deploy-resume-e2e and browser-tilion run passed all three domains in 330.9 seconds.

## Human feedback

Keep explicit speed inheritance, repair the correct property rather than
masking the failure with a default, preserve every network guard and behavioral
assertion, and run only the affected normal blackbox domain while full coverage
continues elsewhere. Do not deploy or change production configuration.

## Reusable lesson

Model new persisted activity inputs at their exact offline transport boundary and assert the inherited value inside the activity.
