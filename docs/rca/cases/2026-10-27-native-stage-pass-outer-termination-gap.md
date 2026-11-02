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


## Later Group4 recurrence on 138f2ccc

Two later interruptions lacked native exit0 receipts. The payment run completed
three PASS verdicts and its exact standing AgentCard release-stall SKIP, then
its outer invocation returned143 during resource cleanup. Three roots already
had sealed-tree/provider/payment receipts. The fourth's canonical DELETE,
exact provider verification and isolated-stack teardown were resumed without
creating another task or card. Original failed cleanup/run/owner records are
retained beside the continuation receipt. The closed card's transfer still has
4,396 sandbox cents consumed and0 released: purchaseHELD/fundingRECLAIMING and
any pending refund remain warning-skip liabilities, not financial cleanup.
Evidence: plan:.context/deploy-fresh-20261027/payment-cleanup-recovery/receipt.json.

The full latency invocation also returned143. Three completed path tests
remained valid, but agent_execute stopped after four partial samples with
Playwright Error: Channel closed; its native runner was absent on inspection.
This is not merely a late outer exit and the partial path is not a pass.
Its exact last fixture agent was confirmed deleted. The existing native
CHAT_LIFECYCLE_PATH=agent_execute selector then ran the unchanged clock guard
and complete five-sample execution test: bothPASS, maximum2076ms. Original
screenshots, partial measurements and interruption remain retained. This
completes the missing acceptance case without proving the interruption's cause.
Evidence: plan:.context/deploy-fresh-20261027/semantic-interruption/receipt.json
and plan:.context/deploy-fresh-20261027/semantic-agent-execute-recovery.log.

The managed memory-termination ledger was absent on both observations. No signal
sender, scheduler or memory cause was established, and no runtime repair is
claimed. Later intentional teardown of the exact owned shared stack is separate
from these unexpected interruptions and preserved its pre-existing database.

## October 29 renewed investigation — U6 sender not recoverable

Replacement session 58200 already used explicit exec and still returned 143,
so removing a redundant shell does not explain the whole recurrence. The
shared stack cleanup started at 05:52:29.319, inside the root's observed
35-second sleep from 05:52:17.385 to 05:52:52.395. Ordinary fan-out cleanup
occurred later and targeted a distinct stack; no causal edge was found.

The retained records lack the initiating sender, cancellation decision and raw
wait status. The memory ledger is absent; the queried system journal has no
records. Numeric 143 alone cannot distinguish an explicit exit from a signal.
The vendored 64-process LRU policy is a lead without an installed revision
match or original occupancy evidence. None of these gaps proves or excludes
external termination, OOM or executor eviction.

Independent review accepts the documented evidence limit only. The existing
October 27 platform report already covers tool 143 with surviving native
groups; no duplicate report or speculative supervisor change was made.
Historical U6 and responsibility remain OPEN. Evidence:
plan:.context/unresolved-six-20261029/webgl-process/U6-REPORT.md.
