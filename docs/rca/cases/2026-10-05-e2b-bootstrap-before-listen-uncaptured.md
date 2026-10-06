---
id: 2026-10-05-e2b-bootstrap-before-listen-uncaptured
date: 2026-10-05
title: An isolated E2B gate backend did not reach listen before its health cutoff
surface: harness
component: isolated-blackbox-backend-bootstrap
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: the standalone launcher started the pinned process but captured no application bootstrap output before health readiness expired
symptoms:
  - Timed out waiting for backend health
  - standalone bootstrap backend.log was empty
  - sandbox creation never started in the rejected attempt
tags:
  - deploy
  - e2b
  - bootstrap
  - observability
sources:
  - commit 7695d9bd9819c6c8bf3d87ce9c039e3c5535a5a4
repro: back-end/scripts/run-blackbox-tests.sh claude-code
status: open
---

## Problem

A mandatory live E2B deploy gate failed before its isolated backend became
healthy. The original bootstrap log is zero bytes. No sandbox or provider call
was made by the failed smoke phase, and that attempt earns no credit.

## Diagnosis

The process used Node 22.13.0 and npm 10.9.2. The wrapper probed health and then
closed its owned process; npm exit 143 followed that cleanup. No loader error,
application stack, or database error established the cause of the pre-listen
stall. Host pressure and shared-client archive leads are not causal evidence.

## Solution

The original interval remains open. A subsequent source-identical product
retry captured private ESM loader diagnostics and genuinely passed the complete
56-case domain, including the real E2B sandbox smoke. Its durable summary and domain
log establish the current gate; they do not retroactively explain the original
stall. No production runtime, provider behavior, or health deadline was changed.

Keep future loader/process diagnostics private if this recurs. Original and
retry evidence plus independent review are retained under
`.context/deploy-runs/pr1410-finalize-20261005/` and the owning test artifacts.

## Human feedback

The user requested inspecting usable setup before reinstall/reset, avoiding
unnecessary acceptance resets, and completing the existing deploy workflow.

## Reusable lesson

Capture the launcher-to-listen interval before attributing a silent backend startup failure to providers or changing runtime deadlines.
