---
id: 2026-07-19-redundant-dark-scrim-layer-on-waitlist-cta
date: 2026-07-19
title: A redundant pill-wide black radial scrim darkened the terminal Join Waitlist CTA
surface: front-end
component: terminal-waitlist-cta
classification: our-bug
problem_class: other
first_bad_boundary: the Join Waitlist CTA markup — an inline pill-wide dark radial background layer stacked behind the label
symptoms:
  - black shadow behind the terminal Join Waitlist CTA
  - "expected 0 dark layers, received 1" on the CTA regression
  - CTA renders with a dark inline background layer
tags:
  - front-end
  - waitlist-cta
  - visual-regression
  - terminal
  - styling
sources:
  - PR #797
repro: front-end blackbox regression rejecting dark inline background layers on the waitlist CTA
status: fixed
---

## Problem

The terminal's Join Waitlist CTA rendered with an unwanted black shadow. The
regression written to pin the behavior failed pre-fix with
`AssertionError: expected [ …(1) ] to have a length of +0 but got 1` — exactly one
dark inline background layer present where none was intended.

## Diagnosis

The CTA stacked a pill-wide black radial scrim behind the label in addition to
the label's own text shadow. The scrim was redundant: the text shadow alone
supplies the readability the scrim was meant to provide, so the extra layer
contributed nothing but the visible darkening. The failure was only detectable by
inspecting the rendered layer stack, which is why the fix shipped with an
assertion over inline background layers rather than a screenshot check.

## Solution

Removed the pill-wide black radial scrim while preserving the label-only text
shadow, and added a blackbox regression that rejects dark inline background
layers on the CTA (pre-fix 1 layer / fail, post-fix 1/1 pass unchanged). The
layer-stack assertion generalizes: any future decorative dark layer reintroduced
on this CTA fails the same test. Frontend suite stayed green at 98 files / 2106
passing and the semantic suite passed 12/12.

## Human feedback

The RCA adversarial review accepted the cause and fix, and required
clarifications about the full test runner and the case history before passing.

## Reusable lesson

When two layers exist to solve the same readability problem, delete the one that
darkens the pixels and assert on the rendered layer stack so it cannot come back.
