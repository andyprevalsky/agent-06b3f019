---
id: 2026-10-15-phone-manager-bypassed-existing-wmh-activity-policy
date: 2026-10-15
title: Phone manager bypassed the existing simulated activity policy
surface: agents
component: call-phone-number
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: agents/domains/call_phone_number/handler.py execute_tool supplied fixed real-call heartbeat and start deadlines
symptoms:
  - Simulated phone activity retains real-call heartbeat timeout
  - Phone activity does not use wmh_activity_timeout_options
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-clock/result.private.json
repro: agents/benchmarks/wmh_world_clock_test.py
status: open
---

## Problem

An offline review control showed that simulated phone activities still received real-call timeout options, although the shared WHM activity-policy helper already defined the approved mode-specific contract. This is a configuration-delivery defect; no captured phone timeout is attributed to it.

## Diagnosis

The phone manager constructed fixed activity options instead of routing its mode through the existing helper. Golden controls assert actual activity arguments and retain all ordinary real-call timeout and retry fields. This is distinct from the earlier simulated phone completion/event-delivery case.

## Solution

The manager now uses the existing helper for simulate/shadow and retains real behavior. No new activity timer, heartbeat, retry budget, model input or provider timeout was introduced. The shared clock/phone registered control file had 13 failures and 13 passes before, 26 passes after; its same-file SHA256 is 3f0e1e0f607f92518510a49452926a923531dc7616995b9129f102e0d0bcd389. Batch subprocess walls were 2.497s and 3.423s, not per-case timings. Parent reported 40 applied clock/wire controls passing.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `9198a95059cd493480a680d8a639c1cdae965be1ee976e1d1b443bac8157ffae`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Route every activity boundary through its established mode policy while testing ordinary-mode arguments unchanged.
