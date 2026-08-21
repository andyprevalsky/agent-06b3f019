---
id: 2026-08-03-verifier-discarded-load-bearing-product-dom
date: 2026-08-03
title: Browser verification discarded load-bearing product DOM after the agent navigated to checkout
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser evidence retention — verifier context retained final and pre-write DOM but had no bounded path for earlier load-bearing page facts
symptoms:
  - verifier says no DoorDash listing links the purchased cable to the required wattage
  - product modal visibly showed six feet and 100 watts before checkout
  - final and pre-write verifier DOM contains checkout state but not earlier product specifications
tags:
  - browser-agent
  - dom
  - ecommerce
  - evidence-retention
  - verifier
sources:
  - agent 43ffeb05-a5e4-4073-9293-0c1c2870ee77
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_requested_browser_evidence_checkpoint_is_bounded_browser_ground_truth
status: fixed
---

## Problem

Before purchase, DoorDash's product modal visibly described the selected cable
as USB-C to USB-C, six feet long, and capable of up to 100 watts. After checkout,
the verifier said the trajectory did not link the purchased listing to the
required wattage. Its context contained the final page, checkout pre-write DOM,
and only the last 30 action records; the earlier product-detail DOM was absent.

## Diagnosis

The acting prompt and verifier had incompatible evidence lifetimes. The acting
agent could correctly read a current product page, but the verifier intentionally
did not retain arbitrary historical DOM because doing so would make long browser
tasks unbounded. The remaining `evaluate` description also told the model to use
a disabled `extract` action for visible content. No safe, bounded operation let
the agent declare that the current browser-extracted DOM contained load-bearing
facts that must survive navigation. Relying only on a JavaScript return value
would be reward-hackable because model-authored code can return a constant.

## Solution

The `evaluate` action now accepts `preserve_evidence=true`. Before executing that
JavaScript, the runtime snapshots the current browser-extracted DOM and retains
it as a separately labeled verifier-ground-truth checkpoint. It does not trust
the JavaScript result as proof. All preserved and pre-write checkpoints share a
three-snapshot cap across the activity and approval-resume boundary. The acting
prompt states the verifier's evidence lifetime and tells the agent to preserve a
load-bearing page before navigating away. Regressions cover the native tool
schema, parameter normalization, bounded checkpoint capture, and verifier labels.

## Human feedback

None recorded.

## Reusable lesson

Give acting agents an explicit bounded path to preserve browser-grounded facts whenever verification intentionally omits arbitrary historical DOM.
