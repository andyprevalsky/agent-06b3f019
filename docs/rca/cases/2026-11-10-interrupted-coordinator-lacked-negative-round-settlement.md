---
id: 2026-11-10-interrupted-coordinator-lacked-negative-round-settlement
date: 2026-11-10
title: Completed native workers outlived their coordinator without round settlement
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: A missing outer receipt had no supported negative settlement transition despite terminal native cleanup
symptoms:
  - "resume requires an interrupted cycle"
  - "invalid choice: 'collect'"
  - "outer observation lost; fresh execution required"
tags:
  - deploy
  - observation-loss
  - recovery
sources:
  - commit cc11dc60c2db1b1a2869425bd2f07ce0a7662831
  - PR #1905
repro: scripts/tests/deploy-test-cycle.test.py
status: open
---

## Problem

The outer gate tool exited143 between the last live observation at07:26:29UTC and its joined observation at07:44:17UTC. Signal sender, exact signal time and cause remain UNRECORDED. Canonical state retained round20/focused and one live structural failure, with19 settled attempts. Native workers continued independently. Their campaign ended07:52:45UTC with13PASS/1massFAIL, native child exit1, all14 task controllers plus the canary cleanup verified, and a quiescent native supervisor. The actual adapter exit was not observed and cannot be inferred from its native child exit or from its result file.

## Diagnosis

The native adapter correctly retained its real task failures and native cleanup. Its case projection applies an existing mass quarantine, so a case PASS is not native task PASS. The lost observation belongs to the vanished outer coordinator. Its ordinary receipt writer and round advancement never ran. No general collect/adopt-existing action existed; resume requires an already-recorded interruption, reexecute launches a new execution, and historical round49 recognition does not authorize arbitrary positive adoption. The actual parser refused collect, and a permanent owning-suite reproduction of the absent recover-round operation failed with SystemExit2. No cause for the parent termination is established by unchanged source or the absence of a memory-termination log.

## Solution

The candidate adds a strict negative-only recover-round transition in the existing cycle command. A reviewed proof binds the entire original raw state, original plan/source/round/phase, original artifact hashes and independently checked native closure. Normal exclusive locking, current process/namespace/descriptor checks, exact requests and ordinary receipt validation remain required. Existing genuine outer receipts are preserved through their ordinary validator; missing outer coverage becomes recovered-native-execution-v1, incomplete/UNVERIFIED, explicit positive_credit=false and unknown outer exit. Such records cannot satisfy full-pass reuse.

A round-bound journal preserves the entire original before any receipt/state publication and permits exact replay after partial publication. Mismatched or uncommitted other journals, mutation, active or unverifiable ownership and incomplete cleanup fail closed. The exact live structural occurrence and historical financial no-retry obligations remain preserved. Normal execution recovery, fixes and fresh affected gates are still required. The same permanent reproduction passes;14 focused owning checks pass, including real live-token process refusal, ordinary PASS tamper controls and journal replay. The combined full suite passed 438 tests in 155.610 seconds with unchanged source hashes; independent corrected-source review passed 17 targeted controls and a real-artifact copied-state projection. Canonical admission and deployment remain pending. Review caught and corrected two gaps: excluded no-retry cases must retain SKIP with explicit unverified current execution, and a distinct uncommitted legacy journal must block even when its round number matches. Both permanent controls fail on the original candidate and pass unchanged on corrected code.

Before any recovery write,50,729 native/canonical evidence members were durably encrypted in29 authenticated parts, fully read back, decrypted and hash verified, with no capture-time mutations. Raw payloads and signed URLs remain private. This is preservation, not execution or financial credit. Golden reference: not applicable; no approval-gated prompt or trajectory change. The unknown parent-termination cause is not repaired or waived by a recovery interface.

## Human feedback

Keep original grades, clocks and missing observations intact. Never invent a worker exit or adopt a fabricated PASS to finish deployment; preserve protected instructions and production privacy guards.

## Reusable lesson

Record lost outer observations as unverified independently of completed native workers.
