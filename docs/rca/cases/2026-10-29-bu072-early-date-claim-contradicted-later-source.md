---
id: 2026-10-29-bu072-early-date-claim-contradicted-later-source
date: 2026-10-29
title: BU072 returned the right interval after an earlier contradictory date claim
surface: agents
component: browser-agent-evidence
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Original assistant message at 18:05:49.998 attributed 37 percent to 1984; later captured source states 1995, and the independent C3 evaluator rejects the retained contradiction; no mechanical transport defect established
symptoms:
  - "polar perfect-score failed (3/4 rubrics)"
  - "the trajectory contains a fabricated contradictory fact"
tags:
  - polar
  - bu072
  - conflicting-evidence
sources:
  - commit d1b1062cfd420832467d4e2b7e10c770a0318157
  - agent 92eaa22b-4350-4b3d-9b7e-8fde8144e1fb
  - plan:.context/r65/r1-proof.json
repro: none-recorded
status: open
---

## Problem

It19 BU072 r1 requested the Girls Who Code interval for a decline from37% by
13 percentage points. The unchanged catalog answer is22. Native status was
COMPLETED, duration176.6s, progress1; the canonical outcome was FAILED,
infra_failure=false. C1/C2/C4 passed and C3 failed. This is distinct from
r2's browser initialization TLS failure.

## Diagnosis

Original assistant message index13 (judge step14), 18:05:49.998Z, says:
“I need to investigate the claim that in 1984, women made up 37% of computer
scientists, and now it's only24%.” It attributes that information to Girls Who
Code before the later captured page evidence. Message23's browser observation
has1995, and message24 explicitly revises the starting year to1995. Message36
captures girlswhocode.com/about-us: “In1995,37% of computer scientists were
women. Today, it’s only24%.” Later chart data associates24% with2017; the final
structured result is22, consistent with2017−1995.

The independent declared evaluator retains both the early contradictory claim
and correct later answer, rejecting only the trajectory's C3 fact consistency.
There is no demonstrated stripped field, missing receipt or output transport
failure. The original natural-language assumption is observable; a mechanical
cause of that assumption is not. Separate encoded actor/verifier request dumps
are absent from the normal seven-member manifest; no model-only replay ran.
Do not classify this as proven model intelligence or alter C3 to excuse it.

Original archive SHA33795b4d0dd29f68491d541c227e4fb3472724abb088404f87ff23406c213bc9;
manifest4d44c52de6f23f8df8b930aba133160f8b66d40ff0b2912d5bc64b79262e4ceb;
run4185c13cd5eee65fa61c92b542ed1c351cca2f4e29bd26a15f9a479b06cc48c0.
All seven original members and exact source/no-patch provenance were verified.

## Solution

OPEN, no runtime candidate. Preserve the early claim, subsequent correction,
correct final answer and failed C3 together. Archive searches for contradictory
fabricated facts and TLS/CDP failures found relatives, not this causal proof.
No task, answer, rubric, model, prompt, budget or grade was changed.

## Human feedback

The coordinator required independent first-bad analysis for both copies rather
than grouping by task ID, and original native/evaluation/infra axes unchanged.

## Reusable lesson

Keep a corrected final answer distinct from an evaluator's retained-trajectory
fact-consistency verdict until an actual mechanical defect is demonstrated.
