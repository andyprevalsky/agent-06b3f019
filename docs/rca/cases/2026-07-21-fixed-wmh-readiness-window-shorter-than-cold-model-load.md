---
id: 2026-07-21-fixed-wmh-readiness-window-shorter-than-cold-model-load
date: 2026-07-21
title: The World Model Harness readiness window was a fixed timeout shorter than a cold model load
surface: agents
component: world-model-harness
classification: configuration-error
problem_class: timeout-too-aggressive
first_bad_boundary: the WMH readiness check — a fixed startup window that expired before a cold model finished loading
symptoms:
  - simulated WMH run fails during harness startup
  - cold model loading exceeds the fixed readiness window
  - simulated ecommerce task cannot start on a cold harness
tags:
  - wmh
  - simulate
  - readiness-timeout
  - cold-start
  - benchmark
sources:
  - PR #826
repro: the WMH Amazon simulated-ecommerce benchmark on a cold harness
status: fixed
---

## Problem

Simulated World Model Harness runs failed at startup rather than during the task:
cold model loading took longer than the fixed readiness window the harness
allowed, so the run aborted before the simulated ecommerce flow ever executed.

## Diagnosis

The readiness check used a single hard-coded window sized for a warm harness. A
cold start is a legitimately different and much slower path — loading model
weights — so any fixed window sized for the warm case turns the first run after a
deploy or restart into a guaranteed failure. The window was also not
configurable, so an operator could not adapt it to a slower host without a code
change. This is the classic startup-probe mistake: treating a bimodal latency
distribution (cold vs warm) as if it had a single bound.

## Solution

Tolerate cold WMH model startup with configurable, bounded readiness timeouts, so
the probe waits long enough for a cold load while still failing rather than
hanging forever. Configurability means slower hosts and CI runners are covered
without further code changes. Verified by the WMH Amazon simulated ecommerce
benchmark passing 1/1 on cloud run `20260720-180734-78393` at commit
`65e43327c`.

## Human feedback

None recorded.

## Reusable lesson

Size a readiness probe for the cold path, not the warm one, and make the bound
configurable — a fixed startup window tuned on a warm service always fails the
first run after a restart.
