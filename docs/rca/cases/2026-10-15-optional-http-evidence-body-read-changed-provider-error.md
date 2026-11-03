---
id: 2026-10-15-optional-http-evidence-body-read-changed-provider-error
date: 2026-10-15
title: Optional HTTP evidence body reads changed the provider failure path
surface: agents
component: rose-http-observer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: providers/rose/whm_retry_observation.py optional aread exceptions escaped the passive observer
symptoms:
  - Optional failure observer raises transport exception
  - Required Foundry body-read error must still propagate
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-transport/result.json
repro: agents/tests/unit/test_review_transport.py
status: open
---

## Problem

Offline provider-owner controls showed that failure-body capture in the optional WHM observer could raise a read exception and change the error exposed to its caller.

## Diagnosis

The observer caught only decoding/value failures. A blanket catch was insufficient as a complete fix: Foundry requires a subsequent body read, while the observer is optional. Suppressing that required read would silently alter ordinary provider behavior. Golden controls therefore distinguish optional observation from required transport consumption.

## Solution

The optional observer suppresses its own body-read exceptions; Foundry explicitly retains required-read propagation. Transport status/fallback semantics and raw capture bytes remain unchanged. The shared owning review batch went 9 FAIL / 12 PASS to 21 PASS with identical tests, and parent reported 21 applied controls passing. These mock controls establish error-routing parity, not live provider acceptance or a new recovery budget.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `b059edbd21cb33aa4afe9618e707c0f49ec63f21788969507ee32a6e82c8497e`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Make passive observation fail independently while preserving every required consumer read and original transport error.
