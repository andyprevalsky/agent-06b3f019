---
id: 2026-10-28-native-autofill-control-omitted-native-read-transcript
date: 2026-10-28
title: Native AutoFill control omitted the native tool transcript after requested screen reads
surface: harness
component: rose-browser-use-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The synthetic host recorded real screen reads in ActionHistory but subsequent native-model calls omitted turn_messages and used a lossy legacy history rendering
status: open
symptoms:
  - The rejected-password control requested screen.text three times instead of assistance
  - Prior phone operation names and receipt identities were absent from subsequent native-model input
tags:
  - phone
  - transcript
  - test-fixture
sources:
  - commit ae7f7bd684856296d557081d55dc9eb8507abbae
  - plan:.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/autofill-fidelity-proposal/REPORT.md
repro: agents/tests/blackbox/rose_browser_use.blackbox.py
---

## Problem

An unchanged live five-scenario control passed four decisions but failed the rejected-password scenario after three requested screen reads. Raw provider output was already phone/screen.text; normalization was faithful. The initial redundant read precedes any history and is not explained by the later history omission. No model-intelligence cause is claimed.

## Diagnosis

Captured inputs grow from zero to two real ActionHistory entries with fresh receipt IDs/cursors. However the legacy formatter retains prior thinking, action phone and a success marker while dropping params.operation and receipt details. Production native execution instead supplies paired tool calls/results through _append_browser_turn_messages. The same offline fidelity oracle fails on the old control's zero native receipt pairs and passes on one/two actual pairs with unchanged read-2/read-3 payloads. Seven original captured request arrays were reconstructed exactly. All five initial request arrays remain unchanged by the proposal.

## Solution

The reviewed test-only correction uses that same production transcript helper after actual chosen reads and actual synthetic-host receipts. It adds no desired action, policy, instruction, model, timeout or retry. All578 original assertions remain, plus four receipt-pairing checks; three observation rounds and90/120s bounds remain. Exact patch53c5a75e9072b120a2ef3ff28772b9efe85046e9ff2372d34f1b23ab39648196 received independent GROUNDED review.

The deterministic fidelity defect is corrected, but the unchanged real five-scenario acceptance is not yet verified: the first corrected native run was blocked before model output by Azure instant-inference quota and OpenRouter HTTP402. Captured OpenRouter metadata identifies openrouter_in_flight_budget and Retry-After120, not proven permanent credit exhaustion. No billing/provider/model/policy setting changed. Preserve every failed attempt and retry only this affected owner on the deployment's prescribed cadence. Replayed original wrong choices still fail in both variants; no behavioral repair is fabricated.

## Human feedback

The original deployment objective remains the planner context fix. No rejected phone-policy proposal or prompt-hash rebaseline is included.

## Reusable lesson

A native-model fixture must use the same paired tool transcript as production after actual tool results; a summary that omits receipt identity is not equivalent input. Prove fidelity separately from model behavior.
