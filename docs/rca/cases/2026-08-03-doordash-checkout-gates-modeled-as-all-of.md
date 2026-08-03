---
id: 2026-08-03-doordash-checkout-gates-modeled-as-all-of
date: 2026-08-03
title: A merge combined an any-of DoorDash contract with a sequence evaluator
surface: agents
component: benchmark-evaluator
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: merge bcb204398 — it retained an any-of expected_attention_kinds task contract and comment while taking an ordered-sequence evaluator for the same field
symptoms:
  - benchmark failed with Expected attention kind payment_approval, observed write_lock | Agent status ACTIVE
  - runner rejected the first attention request and left the write_lock unresolved
  - post-migration exact benchmark still failed ACTIVE with Timeout after 1759s (dynamic cap=900s)
tags:
  - benchmark
  - doordash
  - ecommerce
  - evaluator
  - approval
sources:
  - commit bcb204398151c13f5284b2dedc66bf077f706c3c
  - commit 9f99a0dd7
  - commit c549523c4
  - commit e90601f9
  - commit 2f9c92d1a
  - plan:agents/benchmarks/runs/20260802_220629_browser-opentable-reservation,browser-instacart-grocery-order,browser-doordash-usb-c-cable,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,browser-amazon-return,minted-a+0c2d11688d28.json
  - plan:agents/benchmarks/runs/20260802_231236_browser-doordash-usb-c-cable.json
  - agent 60db7b36-a9dd-4d54-8801-5c599fd93bd5
  - agent 43ffeb05-a5e4-4073-9293-0c1c2870ee77
repro: agents/tests/blackbox/benchmark.blackbox.py test_doordash_poll_accepts_single_write_lock_as_checkout_approval
status: open
---

## Problem

The DoorDash task declared `expected_approval_count: 1` and listed
`payment_approval` plus `write_lock` under a field documented as allowed
terminal alternatives. The epoch-8 benchmark observed a `write_lock` first,
but the runner rejected and left it unresolved with `Expected attention kind
payment_approval, observed write_lock | Agent status ACTIVE`.

## Diagnosis

The task definition was initially internally consistent. Commit `9f99a0dd7`
documented `expected_attention_kinds` as allowed terminal kinds and matched an
observed request with membership. Commit `c549523c4` configured DoorDash for
exactly one auto-approved request while retaining that any-of behavior.

The first bad boundary was merge `bcb204398`. Its other parent, `e90601f9`, had
repurposed the same field as an ordered sequence indexed by the observed
approval count. The merge retained the any-of field comment and DoorDash task
but took `_expected_attention_kind(task, observed_count)`, silently making the
first listed value mandatory. The local polling regression is causal proxy
evidence for this contract collision; it is not exact benchmark outcome proof.

The field remains ambiguous after the DoorDash migration: its dataclass comment
still says alternatives, the main poller treats it as a sequence, and the
ignore-mode post-run evaluator treats it as alternatives. Instacart still
lists both kinds in that field, so the class-level contract bug is unresolved.

This is related to the generic-purchase response-schema case because both
mistakes over-constrained acceptable provider completion evidence, but the
first bad boundaries are independent: this case is in benchmark attention
evaluation, while the prior case was in generated response schemas.

## Solution

Commit `2f9c92d1a` made a narrow, contract-aligned DoorDash migration to the
existing `expected_attention_kind_any_of` field. The task's other evidence—one
expected approval, one auto-approved checkout boundary, and a semantic
payment-or-write-lock criterion—supports that point migration. The synthetic
polling regression accepts and resolves one write lock.

The exact post-migration benchmark did trigger and resolve one approval, but it
still failed `ACTIVE` after 1,759 seconds during a clamshell-sleep-invalidated
run. It is red-to-red, not outcome proof, and no durable C-07 fix approval was
recorded before that rerun. The case therefore remains open. A class repair
must give sequence and alternative contracts unambiguous names and semantics,
then migrate and regress every multi-kind task, including Instacart.

## Human feedback

None recorded.

## Reusable lesson

Reconcile field meaning across both parents of a conflicted merge; comments, task data, polling logic, and post-run validation must agree on whether multiple values are alternatives or a sequence.
