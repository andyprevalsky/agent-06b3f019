---
id: 2026-10-28-video-mock-dispatched-readiness-probes-as-generation
date: 2026-10-28
title: Video mock dispatched non-API readiness probes to an uninitialized scenario handler
surface: harness
component: agent-tools-video-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The ephemeral mock parsed and counted HEAD / before calling a handler only initialized by individual Gemini scenarios
status: fixed
symptoms:
  - Ten video assertions passed but node:test failed with post-hook handler is not a function
  - An unrelated HEAD request polluted a scenario's exact request count
tags:
  - video
  - readiness
  - test-fixture
sources:
  - commit 5dc75f4fd1759a3fd7f09928a91cbd66a50afab3
  - plan:.context/deploy-fresh-20261027/rca-video-posthook-batch13/REPORT.md
repro: back-end/src/tests/blackbox/agent-tools-video.blackbox.ts
---

## Problem

The coverage owner reported all10 video assertions passing, then failed its process on asynchronous before-hook activity: TypeError handler is not a function. The scenario handler is deliberately initialized only by each test, but the HTTP server accepted every path before dispatching to it.

## Diagnosis

A real HEAD / before the first scenario reproduces the same post-hook error: original10 assertions pass but process exits1 in6.006s. Separate unforced native HEAD / requests with User-Agent sprite-daemon were observed; one also polluted an active scenario's exact request count. The original batch requester was not captured, so its identity is not reconstructed.

## Solution

Reject paths outside the mock's /v1beta/ API namespace with404 before parsing, counting or scenario dispatch. The identical controlled command then passes10 assertions and process0 in6.357s. A registered HEAD non-dispatch/counting case gives11/11 native pass in6.194s; removing the guard fails its404 assertion. All56 original assertions and all10 complete test bodies remain identical, with no production, model or timer changes.

The earlier default503-only proposal was rejected because probes could still affect an active scenario's counter. Exact final patchc3369c0ddf45be629bc12e87daa8861c16b3a2de1dea84d03003015046cf0d00 received independent GROUNDED review. Source and native process/database/listener cleanup receipts are in the referenced report. Broader coverage acceptance remains separate.

## Human feedback

No new feedback was recorded; preserve all original assertions and do not disable host services to accommodate an incomplete mock.

## Reusable lesson

An ephemeral API mock must reject unrelated paths before scenario accounting and dispatch; readiness probes are not provider operations.
