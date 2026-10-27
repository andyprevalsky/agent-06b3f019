---
id: 2026-10-27-native-stage-pass-outer-termination-gap
date: 2026-10-27
title: Native stage pass receipts coexist with an untraced outer shell termination
surface: harness
component: deploy-stage-wrapper
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Outer command session reports143 after the native stage recorded exit0; sender and signal timing were not retained
symptoms:
  - "frontend native exit0 with outer session exit143"
  - "command structural native exit0 with outer session exit143"
  - "/run/boxes-memory-terminations.jsonl absent"
tags:
  - deploy
  - signal
  - wrapper
  - evidence-gap
sources:
  - commit 04333dbbdea0b8b3b8d8cc9aa3b75475b53384c6
  - plan:.context/deploy-fresh-20261027/outer-termination-review/REPORT.md
  - plan:.context/deploy-fresh-20261027/batch6-monitor/receipts.json
repro: No sender or causal signal reproduction retained
status: open
---

## Problem

Batch6 frontend native coverage passed229files/3824tests and the stage producer recorded exit0 at04:23:46 after814.3s, but joining its outer command session returned143. The structural command later recorded all67gates passing and exit0 while its outer session also returned143. A read-only monitor process was separately terminated143 and resumed from persistent receipts without restarting native tests.

## Diagnosis

The managed memory-termination ledger is absent. Original raw signal sender/wait-status evidence is unavailable. The stage runner launches its native child in a new session and installs forwarded signal handlers. Native producer output and atomic stage records corroborate their exit0; outer process termination does not establish a native test failure. Read-only observation of an orphaned command-stage wrapper and isolated native child confirms the possible wrapper/child separation, but does not establish that a specific cleanup or external process sent the signals.

## Solution

No source correction or causal repair. Preserve the native pass and unexplained outer termination as separate facts. Keep wrapper process identity, raw status and signal provenance on a future recurrence before assigning a cause. Later canonical command acceptance remains necessary; no production or Mac acceptance is claimed.

## Human feedback

None recorded for this failure. Managed machine instructions require checking the memory termination ledger on unexpected143 and prohibit broad signals or killing PID1.

## Reusable lesson

Retain wrapper and native-child outcomes separately and collect signal provenance before attributing an outer termination to a passing test command.
