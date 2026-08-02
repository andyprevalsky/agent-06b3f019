---
id: 2026-07-14-calendar-snapped-windows-and-unscoped-cohorts
date: 2026-07-14
title: Company Health mixed calendar-snapped ranges with subscriber-only denominators and unscoped task counts
surface: back-end
component: company-health-metrics
classification: our-bug
problem_class: other
first_bad_boundary: the Company Health range builder snapped to calendar boundaries while the cohort filters used a subscriber-only denominator and an unscoped root-task count
symptoms:
  - Company Health reports 15,276 tasks for a single subscribed user
  - period-over-period comparisons incoherent because current and prior windows are not equal length
  - activation funnel numbers do not reconcile with the user cohort they claim to describe
tags:
  - admin-dashboard
  - metrics
  - company-health
  - cohorts
  - utc-windows
sources:
  - PR #767
repro: none-recorded
status: fixed
---

## Problem

The Company Health dashboard produced values that could not be true — most
visibly 15,276 tasks attributed to a single subscribed user — and its
period-over-period comparisons were incoherent. The activation funnel also did not
reconcile with the cohort it purported to measure.

## Diagnosis

Three independent definition errors compounded in one view:

1. **Ranges were calendar-snapped.** A "past 7/30/90/365 days" figure was computed
   against calendar boundaries, so the current window and its baseline were not
   equal-length complete windows and could not be compared to each other.
2. **The denominator was subscriber-only** while the numerator was not, so rates
   were computed over mismatched populations.
3. **Root-task counts were unscoped**, so tasks outside the intended user set were
   attributed to whichever user the row was joined against — the mechanism behind
   the 15,276-tasks-for-one-user reading.

No single query was "broken"; the metric _definitions_ disagreed with one another,
which is why the output looked plausible in shape and impossible in magnitude.

## Solution

Replaced calendar-snapped ranges with rolling, complete UTC-day windows for the
past 7, 30, 90, and 365 days plus equal-length prior baselines, so every comparison
is like-for-like. Corrected the user and task cohorts (Tamy included, Andy
excluded) and scoped root-task averages to the intended users. Reusable health
snapshots are now cached at the service layer keyed by retrieval UTC day and time
slice, with degraded results evicted rather than served, and the activation funnel
renders as a bar chart for the requested visual hierarchy.

## Human feedback

The record notes the activation funnel "lacked the requested visual hierarchy" and
that the cohort had to include Tamy and exclude Andy — both explicit user
requirements that the implementation was corrected to satisfy.

## Reusable lesson

When dashboard numbers look impossible rather than merely wrong, audit the metric
definitions first — window snapping, denominator population, and join scope — since
each can be individually defensible while their combination is meaningless.
