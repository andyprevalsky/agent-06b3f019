---
id: 2026-08-29-blue-bottle-payment-without-ferry-pickup-grounding
date: 2026-08-29
title: Blue Bottle payment approval grounded item+$12.25 but not Ferry Building or pickup window
surface: agents
component: spawn-browser-agent-v3 / request_payment_card approval text
classification: our-bug
problem_class: other
first_bad_boundary: checkout reached request_payment_card with line-item approval text lacking pickup location/time after store-finder/Ferry clicks that did not stick on the orderable Ferry store
symptoms:
  - required Ferry Building pickup and pickup time/window are not grounded
  - approval contains no pickup location or pickup time/window
  - store finder did not show or select Ferry Building
  - "KSE Shakerato — Vanilla Bean, 16oz, Regular, Almond x1: $12.00"
tags:
  - blue-bottle
  - ferry-building
  - pickup-time
  - payment-approval
  - semantic-judge
sources:
  - fleet run 670cb9b0-5781-4c46-a4e8-9b93c3910842
  - agent 2ace42ce-4607-4d25-875a-4f964708af2c
  - agent 1cba6647-b233-42f2-aafe-40fd6729494b
  - PR #1069
repro: pending — owning-boundary repro for approval scrape vs selected store not yet isolated
status: open
---

## Problem

Post kill-switch k=5 trial `2ace42ce` triggered one unresolved payment approval for the
correct drink and $12.25, but `blue_bottle_pickup_order_semantics` scored 0 because the
approval text had no Ferry Building pickup or ASAP/pickup window. Judge also cited earlier
verifier text that Ferry was not selected on the store finder.

Pass `1cba6647` approval line included `ASAP pickup in 9–19 min` and tree evidence named
`NorCal - Ferry Building - 1073` / `1 Ferry Building`.

`2ace42ce` did click Ferry Building store-finder rows and toggles, but also navigated to
`bluebottlecoffee.com/cafes/ferry-building` marketing pages mid-flow before Checkout →
payment. No guest firstName/lastName/Credit-Debit actions.

## Diagnosis

Archive searches: `Ferry Building pickup time payment approval blue bottle`. Hits include
DOM-patching and kill-switch cases (relatives, different boundaries). **Novel** for
payment-with-item-without-pickup-grounding under auth_source=none.

Unresolved whether first-bad is (a) agent never locking the orderable Ferry store before
checkout, or (b) `request_payment_card` scrape omitting location/time that was on-page.
Pass vs fail approval text difference (`ASAP pickup in 9–19 min` present only on pass)
supports scrape-follows-DOM; need a DOM snapshot at payment time to close the gate.

Status **open** — outcome reproduced on the bench; causal owning-boundary not yet isolated.

## Solution

**Proposed:** Before `request_payment_card`, require visible pickup location + time on
checkout (or re-select Ferry / ASAP). Optionally enrich payment approval payload with
scraped pickup fields when present in DOM. Cement with a fixture/unit asserting approval
text includes location/time when those DOM nodes exist — without relaxing the semantic
judge.

## Human feedback

User asked for `/rca` of post-fix k=5 failures.

## Reusable lesson

Item+total on the payment approval is not sufficient for a pickup-location bench — verify
pickup location and window are present in the approval (or tree DOM) at the payment
boundary, not only earlier store-finder clicks.
