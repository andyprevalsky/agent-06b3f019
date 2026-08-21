---
id: 2026-08-03-return-confirmation-absent-from-write-lock-phrases
date: 2026-08-03
title: Return-confirmation controls were absent from the browser write-lock phrase classifier
surface: agents
component: browser-write-lock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: write-lock phrase classification — Confirm your return was not classified as an irreversible purchase-like action
symptoms:
  - Amazon return completed without triggering the required approval request
  - agent clicked Confirm your return and immediately reached Your return request is confirmed
  - benchmark reported Expected approval requests but none were triggered
tags:
  - browser-agent
  - ecommerce
  - irreversible-action
  - return
  - safety
  - write-lock
sources:
  - commit 1b68963da0
  - agent 2fe8dba2-2938-42b8-a7fb-423cd1f44989
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_execute_click_write_lock_return_confirmation_triggers_approval
status: superseded
superseded_by: 2026-08-03-shadow-input-sibling-label-omitted-from-write-lock-signal
---

## Problem

The Amazon return benchmark reached a final control labeled `Confirm your
return` after selecting a $21.71 refund to the original payment method and a
free Whole Foods no-box/no-label drop-off. The browser clicked that control and
completed the real return without emitting the required irreversible-action
approval request. The benchmark correctly failed because it expected an
approval request and observed none.

## Diagnosis

The first bad boundary was the deterministic write-lock phrase classifier.
`PURCHASE_BUTTON_PHRASES` recognized purchase and order controls but omitted
return-confirmation language. Consequently, `_execute_click` did not treat
`Confirm your return` as an irreversible purchase-like action and allowed the
click to reach the site. An exact focused replay with the return phrases removed
failed at `assert is_purchase_button("Confirm your return")`; restoring the
phrases made the same replay pass. The browser integration regression also
shows the control triggering the write lock before the click executes.

## Solution

Commit `1b68963da0` added `confirm your return`, `confirm return`, `complete
return`, and `submit return` to the write-lock phrase set. It also cemented a
classifier regression for representative return and order controls and an
integration regression proving that clicking a return-confirmation control
raises an attention request instead of executing the site action. The complete
`spawn-browser-agent-v3` owning domain passes with the fix.

This diagnosis was superseded after an audit established that commit
`1b68963da0` and its phrases predated the failing August 2 run. The archived
runtime target was a textless shadow-DOM `input`; its `Confirm your return`
label was rendered in a sibling node that neither write-lock signal extractor
included. The corrected diagnosis and open outcome gap are recorded in
`2026-08-03-shadow-input-sibling-label-omitted-from-write-lock-signal`.

## Human feedback

None recorded.

## Reusable lesson

Classify irreversible controls by the state change they commit, not only by purchase vocabulary; cancellations, returns, refunds, and submissions require explicit safety coverage.
