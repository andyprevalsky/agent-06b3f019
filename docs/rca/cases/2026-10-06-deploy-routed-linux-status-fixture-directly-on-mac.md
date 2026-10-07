---
id: 2026-10-06-deploy-routed-linux-status-fixture-directly-on-mac
date: 2026-10-06
title: Deploy ran the native Linux status fixture directly on macOS
surface: harness
component: cloudbench-native-linux-test-routing
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: deploy Step 4cb invoked a Linux proc status fixture directly with the macOS host interpreter
symptoms:
  - native status fixture failed on macOS after 30.320 seconds
  - unchanged status fixture passed inside its existing offline Linux image
tags:
  - cloudbench
  - linux
  - macos
  - native-fixture
sources:
  - commit 5233c125258139b2c71a7d35a8a39d7f30d02984
  - PR #1424 deploy
  - agent /root/fresh_basic_claude_final50_cli
  - plan:.context/fresh-basic-claude-final50-20261006/deploy/controller-linux-route-followup-v3-qualified.safe.json
repro: scripts/tests/cloudbench-controller-linux.test.py
status: open
---

## Problem

Deploy directly invoked the Linux proc/status fixture on a Mac and got exit 1
in 30.320 seconds. The unchanged actual fixture passed on native Linux through
its existing offline controller image. This is a routing failure, not a
production status-service failure or permission to skip the gate.

## Diagnosis

The fixture depends on Linux process identity and proc observations. The
first bad boundary is bypassing the existing format/toolchain-specific native
dispatcher. The prior macOS keychain fixture case is an OS-routing relative;
it does not prove recurrence at this controller boundary. The new selector
controls fail on the unchanged dispatcher before any Docker ownership call.

## Solution

Reuse the existing dispatcher with a finite status-service-shutdown selection;
keep its original multi-workstream default. Route the CLI/test/deploy pointers
through it. Invalid/foreign selectors fail before Docker operations. All
original exact-container ownership controls remain, and root independently
verified 12 controls in 2.909 seconds. Actual status source remains unchanged
until narrow integration registration of the already-reviewed cohort owner
function in the same native fixture. That exact existing stdlib-only function
checks proc-start owner acceptance, wrong parent/publisher ticks and legacy
birth compatibility without pytest/dotenv installs, a new family or image
recipe changes. The dispatcher copies its owning test file through the same
source-sealed two read-only mounts. Existing cleanup and provider scope remain.

Final composed registration proof and mandatory deploy gates are recorded in
the private composition receipts. Integration/outcome remains pending, so
status stays open. No actual campaign timing or provider allocation is claimed.

## Human feedback

None recorded for this specific route finding. Root required the existing
native fixture, exact container ownership/cleanup, invalid-before-Docker
controls and compact permanent registration with no new dependency framework.

## Reusable lesson

Run platform-specific controls through their existing native dispatcher while preserving ownership checks and finite fixture selection.
