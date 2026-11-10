---
id: 2026-10-29-oss-foundry-unsupported-deploymentless-fallback
date: 2026-10-29
title: OSS Foundry leg retries unsupported deploymentless DeepSeek before successful fallback
surface: agents
component: foundry-route-eligibility
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Foundry selection synthesizes a deploymentless DeepSeek model when no matching explicit deployment is listed
symptoms:
  - deployment_disabled
  - DeepSeek-V3.2 does not support deploymentless inference
  - rose.complete.foundry.fall_through
tags:
  - foundry
  - deploymentless
  - recovered-provider-error
sources:
  - PR #1634
repro: .context/pr1634-foundry-triage/handoff.json
status: open
---

## Problem

Five requests in the WebDecoy smoke encountered an unsupported deploymentless
DeepSeek-V3.2 request, then completed through Kimi fallback. The rejected leg
added0.634–1.150seconds before fallback. This is a recovered provider-leg error,
not proof of a failed task or fixed routing.

## Diagnosis

The OSS pool selects DeepSeek. Foundry selection synthesizes a slot-one model
name when no explicit matching deployment exists. The provider reports
`deployment_disabled`; streaming classifies it as RoseServerError and falls
through without a deployment eligibility cooldown. Five exact request/error/
fallback pairs and the read-only selection replay are retained in
.context/pr1634-foundry-triage/handoff.json. Later image-bearing requests skip
this leg because vision is required, not because the unsupported route healed.

## Solution

No runtime change is claimed. A future correction should require an explicit
eligible deployment for models that do not support deploymentless inference,
while preserving legitimate GPT compatibility behavior and fallback. The
observed calls recovered. The separate WebDecoy session-metadata assertion
failure has a different first-bad boundary and is not attributed to this leg.

## Human feedback

The user requested finishing deployment and fixing intervening issues. No
provider routing or benchmark gate override was inferred.

## Reusable lesson

Successful fallback does not make an unsupported first leg healthy; preserve
its exact error and latency, and distinguish it from the task's verdict cause.
