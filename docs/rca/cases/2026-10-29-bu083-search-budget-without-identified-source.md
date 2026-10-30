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

## R102: It25 BU083r1 original budget pause

Original r001-j0003/root06968b69-9878-4b21-b845-2d21a78f5418 ran
source3dc00896d3b8dcc0b3666c9c8493507ee96c7809 with no patch. Archive
93424fdd71e2298ef1c94a25a5126869f7b45147eb248661ee187930baf92d52
and normal manifesta777a89c467bad315700e3490ae7a4494646807b25acc5487d8a86427dbc00c6
bind seven members independently verified by size and SHA256.
NativePAUSED2101.0s/progress0 is separate from canonicalFAILED/infraFALSE.
The low-progress gate fails; no declared semantic judge result is recorded.

The task again asks for an athlete's hometown by identifying November2019
and January2020 articles and their publishers. The retained trajectory keeps
searching across candidate sports/articles without establishing the requested
source and hometown. The required athlete_hometown string schema preserves
that request; no completed structured answer is present.

Original driver line16692 explicitly says Browser step budget reached100/100,
pausing for polar judge. Backend logs show POST to this root's pause endpoint
at03:28:31.571Z, returning200 at03:28:31.805Z. Worker24503 receives PAUSE at
03:28:31.806357Z and records activity cancellation at03:28:35.986499Z. The
label “paused by user” does not establish a separate human intervention: the
captured driver and API call identify the budget-triggered path.

The last completed actor call is browser_use_step_99: exact decoded original
request/output SHA256
98778d562bc84386fa558bf192236e471211f663c4b168120aecaf5cb13e3bfb.
It chooses evaluate(document.body.innerText), reading Bing results for a Golf
Digest January2020 interview/hometown query. The result is delivered at
03:28:29.617Z. Step100 starts at03:28:30.668089Z, request699519701b3a, before
the pause arrives; no completed response for it is claimed. There is no
recorded completion-verifier result or accepted hometown to recover.

Source _agent_class_step_counts counts distinct explicit steps_taken values.
The original final messages contain100 distinct values0..99, explaining the
driver's100/100 observation even though the final completed call is99.
Separately104 recorded action phases comprise53goto,46evaluate and5
read_browser_state, with five observation-budget refund events. Raw action
receipt counts, distinct counter values and model-call labels are different
measurements; their differing values alone do not prove a counter defect or
a causal completion failure. No cap or counting change is proposed.

The pause's browser cleanup reports HTTP500, but the later normal terminal
receipt records the same Tilion session sess_98241c69135549f6b6ac64f933730e57
DELETE204 with root_deleted/tree_sealed and cleanup_failure null. The earlier
failure is retained separately and does not establish terminal infrastructure
failure. Zero summary usage counters do not mean zero browser execution.

Two archive searches used “Browser step budget reached100 pausing” and
“BU083 scoring methods hometown research.” This case's Solution and Human
feedback were read. The evidence matches its observed unfinished-research /
budget-pause boundary, so this occurrence is appended rather than creating a
duplicate repair lane. Underlying research failure remains OPEN without a
controlled causal reproduction. No model-intelligence claim, forced athlete,
search prompt change, replay, new native/DB/provider call or live-source edit.
Original grade and clocks remain unchanged. Tokens UNMETERED.
