---
id: 2026-10-29-bu083-search-budget-without-identified-source
date: 2026-10-29
title: BU083 exhausts the search budget without identifying the requested source
surface: agents
component: browser-research-termination
classification: unresolved
problem_class: other
first_bad_boundary: The retained search trajectory reaches the original 100-step budget without establishing the requested article or athlete; no mechanical transport defect is established
symptoms:
  - "Browser step budget reached: 100/100 — pausing for polar judge"
  - "Low progress score: 0.00"
  - "Max iterations reached: 100"
tags:
  - polar
  - bu083
  - research
  - pause
sources:
  - commit 47a0e9d6c9a89e2d97933935509343372d565250
  - agent dd3b3ebd-41b8-4247-ac75-8129c2163abb
  - plan:.context/r83/proof.json
repro: none-recorded
status: open
---

## Problem

It21 BU083r1/r001-j0003 asks for an athlete's hometown by matching two dated
articles, their publishers' founding decades, and a sport-scoring description.
Native state is PAUSED after2422.8s with progress0; canonical status is FAILED,
producerinfraFALSE. No declared evaluator result is present. Preserve these
separate axes; no claimed answer or successful task is established.

## Diagnosis

Archiveef3ef35d6c5e2e734cda5d6d0fa5ba69828316d55b4ad4c51f1de2dca87b7027,
run840d666c1e719146496424f89e1150d3cce6e0c8b0d023343a3878895db97b9c,
and manifestcf27a41125b85efbfd2ac794d832b6da3517cfd0779bf81f1fa2c6b6cfefe81d
were verified with all seven original member hashes/sizes and source47a0/no
patch provenance. The retained trajectory continues trying search queries and
reading loaded result pages, without establishing the target article, athlete
or hometown. A lack of the right answer does not establish a generic model
capability defect or a broken search transport.

The supplemental original driver positively identifies the pause initiator:
line19257 says “Browser step budget reached: 100/100 — pausing for polar judge.”
Worker line23888 records workflow PAUSE at21:29:26.702586Z. The in-flight final
evaluate finishes at21:29:37.827120Z; action106 is recorded, then the browser
logs Max iterations100 at21:29:37.992395Z and cancellation/paused at
21:29:41.697241Z. EXECUTE ends paused at21:30:08.657390Z.

There are106 distinct captured action receipts:53goto,47evaluate and6
read_browser_state. Six original worker events explicitly refund observation
steps, consistent with the source's adjust_iteration_after_action contract.
Thus106 receipts are not106 budgeted model turns and do not by themselves
prove that the100-step bound was exceeded. No attempt_completion receipt or
verifier-context event is retained, and there is no declared-judge result.
Source enters its final-synthesis path after budget exhaustion, but the
recorded cancellation arrives before a completed synthesis/verifier result.
This is an observed ordering, not proof of a missing cancellation guard or
local signal-delivery race. Workflow PAUSE and activity cancellation receipt
are distinct boundaries.

The normal final cleanup independently records exact Tilion session
sess_b2803841993c42598a067483a945416b DELETE204, root deletion/sealing, no
unsealed children, and empty cleanup errors/warnings. Incidental late recording
or passkey-capture failures do not override that closure evidence or prove a
new terminal infrastructure failure.

## Solution

OPEN. No deterministic general runtime repair was established from the retained
chain. Do not increase caps, force an expected athlete or hometown, rewrite the
search instructions, or regrade the original. Additional evidence would need
to identify a specific lost source/result or a proven action/cancellation
admission defect; none was manufactured through a new model/browser replay.
No runtime edits or new tests were made.

Archive search found prior budget/paused source-evidence cases, including the
BU067 Google Finance source gap and BU051 visual-evidence case. They are
comparators only: this task's missing source identification is not automatically
the same cause or a regression of their repairs. All original records and
clocks remain unchanged. This is a docs-only case on the supplied future
composition; active owner/root source is untouched.

## Human feedback

The coordinator required original pause/budget/actor/evidence separation,
positive infrastructure findings if present, and a bounded causal decision.
Do not infer a prior family from PAUSED, or treat generic search failure as
authority for another retry, budget change, or model-intelligence label.

## Reusable lesson

A budget-driven pause, a local activity cancellation, and a source-identification
failure are separate observations. Count budgeted decisions rather than all
action receipts, preserve positive cleanup evidence, and require a concrete
mechanical defect before turning an unresolved search into a runtime patch.
