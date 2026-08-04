---
id: 2026-07-21-simulated-browser-observation-shapes-diverged-from-prod
date: 2026-07-21
title: The simulated browser path emitted observation/action shapes the real agent loop could not consume
surface: agents
component: world-model-harness
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the simulated WMH browser path — generated observations and actions were not normalized to the shapes the production browser loop consumes
symptoms:
  - simulated WMH browser flow cannot complete a multi-step ecommerce task
  - generated browser observations are not normalized
  - approval resume does not work on the simulated browser path
tags:
  - wmh
  - simulate
  - observation-normalization
  - browser-agent
  - fixture-parity
sources:
  - PR #826
repro: the WMH Amazon simulated-ecommerce benchmark (grounded multi-step flow plus approval resume)
status: fixed
---

## Problem

The simulated World Model Harness browser path could not drive a grounded
multi-step ecommerce flow. The record's root cause statement is explicit: the
simulated browser path lacked several observation/action-shape normalizations, and
approval resume did not work on that path.

## Diagnosis

The simulator produced browser observations and actions in shapes that differed
from what the production browser loop consumes. Because the agent loop is the same
code in both modes, any divergence in the _data_ shape surfaces as an
inexplicable agent failure rather than as a simulator error — the loop is being
handed input it was never written to parse. The generated (model-authored)
observations were the specific weak point: nothing normalized them to the
production contract before they entered the loop. Approval resume (write, payment
card, authentication) had no simulated equivalent at all, so any flow that needed
an approval could not continue.

## Solution

Normalized generated browser observations and added the missing observation/action
shape handling so the simulated path supports grounded multi-step ecommerce flows,
and made simulated browser sessions resume after write, payment-card, and
authentication approvals. Screenshot-replay recording infrastructure was preserved
and self-contained playback recordings added, so simulated activity remains
inspectable. Verified by the WMH Amazon simulated ecommerce benchmark passing 1/1
on cloud run `20260720-180734-78393` at commit `65e43327c`.

## Human feedback

None recorded.

## Reusable lesson

A simulated environment must emit the exact observation/action shapes production
emits — normalize model-generated fixtures at the simulator boundary, or every
shape drift reappears as a mysterious agent failure.
