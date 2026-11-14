---
id: 2026-10-30-it27-bu097-stall-before-next-browser-model-call
date: 2026-10-30
title: It27 BU097 stalls after tab switch with partial CDP silence and no captured awaiting stack
surface: agents
component: browser-step-boundary
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: next iteration enters after acknowledged tab switch but no subsequent model dispatch occurs; exact suspended await is not captured
symptoms:
  - tree stalled after 516 seconds
  - native PAUSED and initialized root progress zero
  - target-specific Page.enable and Runtime.runIfWaitingForDebugger silence
tags:
  - r112
  - polar-bu-097
  - cdp
  - tab-focus
sources:
  - commit 98c8668b47b5e9b2fd2b807c2f083f2e46a04733
  - agent c9bb16b7-154c-4a97-97b1-631e37c0b561
  - plan: original archive 0276cbcac658bfca34d9e56b4cd24efe575f4c7641f020070c89b0f4acc0859d
repro: offline exact-source helper control proves possible foreign-page lookup stall only; original awaiting identity remains unknown
status: open
---

## Problem

Native PAUSED after 713.7s, canonical FAILED, producer infraFALSE, lifecycle verified. The original task requests the birth year of an artist meeting four scholarship/band/film/marriage constraints. Its actual persisted required nonnullable integer birth_year field and version1 value/text presentation faithfully express that requested output. No original completion candidate or completion-verifier invocation/result was found. There is therefore no evidence of a validator rejecting a correct submitted birth year.

Root progress zero is Agent.progress initialization, not a verifier score. Original worker60 initializes ACTIVE/progress0. Task-progress-estimate telemetry is distinct and reaches 0.6329113924050633 at 06:51:30.818634. The original driver stall predicate uses durable message/cost/world-model activity, not cursor movement or these estimates. No score or cap change is justified.

## Diagnosis

The final model request browser_use_step_6 completes at 06:51:27.005974. switch_tab is acknowledged at 06:51:30.774644 and its FINISHED message is saved by 06:51:30.796611; its destination is worldmusiccentral.org/artist-profiles-a-r-rahman/. The last browser.step.phases record is emitted at 06:51:30.819266. There is no later model request or completed step before PAUSE at 07:00:17.142044.

Important source refinement: StepPhaseTimer.start_step emits the preceding step's record. Thus the last phase event demonstrates entry to the following iteration, not an arbitrary unfinished tail of the successful action. The next ordering is checkpoint, user-control fetch, tab-runtime rebind, instruction sync, then guarded observation/model dispatch. The user-control HTTP fetch has a 15s timeout; an actual user-ownership state could deliberately keep yielding. No original ownership-change evidence was found, but absence of a saved response does not prove its return state.

The rebind helper enumerates Playwright pages sequentially, potentially awaiting new_cdp_session, Target.getTargetInfo, detach and bring_to_front before continuing. Those awaits have no local bound. This is a credible owning seam, but no saved Python awaiting stack, per-phase entry record, exact client request ID, or cache content identifies the suspended operation. Do not label this original a proven rebind hang.

### Captured transport evidence

At worker13073/06:51:57.768477 the IndiaToday target 2D2544DDB718/session54A544FBA9F3 has 20 pending Page.enable calls, silent31s; another session replied 0.0s earlier. At13458/06:52:02.769185 another session on that target waits Runtime.runIfWaitingForDebugger, again while another session responds. Metrics, loop baselines and independent idle cursor callbacks continue. This establishes partial target/session unresponsiveness; it does not establish whole-connection loss, provider cause, or which of those requests owns the stalled foreground coroutine. No upstream-close/reconnect sequence was found before cancellation.

The driver later reports newest-active silence516s against510s, messages38, nonterminal leaf1. Pause cancels the activity; terminal messages increase the saved total to44. Late closed-CDP/mouse errors follow cancellation and are not the first bad boundary.

## Solution

All supplied files were checked for the missing awaiting-stack discriminator: guest diagnostics contain CPU/memory/process/Postgres samples, stack.log contains startup logs, driver output contains no task stack or checkpoint dump, and worker records contain no coroutine/frame/awaiting-stack fields. No extra capture or endpoint was used. The original PAUSED/FAILED/infraFALSE classifications and lifecycle evidence are preserved.

Two archive searches were completed (search1.txt, search2.txt). Personally read the full ad-heavy DOM-snapshot case and R84 diagnostic-attachment case, including Solution and Human feedback. In the former case, the A/B test did not support emulation fanout or mux head-of-line blocking as the cause in that tested session, page and set of conditions. That result does not rule out those mechanisms in R112; R112's emulation noise alone also cannot establish them. R84 has an explicit supervisor-timeout then pending diagnostic-attach sequence and an owning reproduction; R112 has neither and must not inherit its verdict.

OPEN: the original loop stops between entering the next iteration and its next model dispatch. The exact awaited operation and upstream reason remain uncaptured. A generic helper-hang fixture could prove a vulnerability but would not uniquely reproduce this original. No causal runtime patch, timeout extension, model replay, progress masking, task regrade or task-PASS claim is justified from current custody. The needed discriminator is an already-recorded activity checkpoint/await stack or identity-bound request trace for that interval; it is absent from the supplied normal packet. No new capture is requested or performed in this assignment.


## Human feedback

The user directed the investigation to prioritize native agent failures, progress zero, and schema/validator data flow while continuing to track all failures, including evaluator failures. This priority does not authorize changing the original outcome or treating initialized progress zero as a validator result.

## Reusable lesson

A successful action followed by silence does not identify the next suspended await. The exact-source offline focus helper resolves healthy pages and detaches acquired sessions; with an earlier foreign page whose attachment never returns, it blocks even if a later focused page is cached, and cancellation propagates. This proves a possible mechanism, not that this original took that path. Preserve request/phase identity before selecting a causal repair; do not turn idle cursor broadcasts into task progress or general emulation noise into a root cause.
