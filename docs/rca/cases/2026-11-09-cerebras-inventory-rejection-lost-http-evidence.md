---
id: 2026-11-09-cerebras-inventory-rejection-lost-http-evidence
date: 2026-11-09
title: Cerebras inventory rejection discarded the HTTP status needed for deploy attribution
surface: back-end
component: cerebras-blackbox
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: cerebras.blackbox.ts observed a non-2xx GET /models then asserted only response.ok; the original provider rejection cause remains unproven
symptoms:
  - "Cerebras /models must be reachable for the live probe"
  - "backend-coverage-blackbox/blackbox:cerebras"
  - "false !== true"
tags:
  - cerebras
  - inventory
  - deploy-gate
  - http-evidence
sources:
  - PR #1864
  - commit 9db9d8435fc5e46934ff3add0353ac8dd03a7145
  - plan:.context/agentcard-e2e/deploy-gate-rca.json
repro: node --import tsx --test src/tests/unit/cerebras-chat-model-not-archived.test.ts
status: open
---

## Problem

The backend coverage gate's only failed constituent was `blackbox:cerebras`.
The mocked exclusive-route contract passed, then the live inventory request
failed its `response.ok` assertion at line 117. The native log preserved neither
the HTTP status nor its response body. The occurrence is
`ae8fcf8aa5af45819c9627e354b986bd`; it remains an actual FAIL.

## Diagnosis

The compared main and failing revision have identical Cerebras test, provider,
transport and gate workflow bytes. That establishes the diagnostic omission
predates this branch, but does not establish the remote rejection's cause.
The same native Node GET from the devbox at 17:17:29Z returned 200 with
`qwen-3.8-27b` and `gpt-oss-120b`. This current, different-host observation
cannot prove what the CI credential/network received at 01:19:51Z.
A Python urllib probe returned 403/1010, but differs from the native client and
is explicitly excluded from attribution. No provider outage, quota exhaustion
or credential exception is established. The original failure stays UNKNOWN.

Archive searches found the October 7 quota case, whose inventory passed and
whose later completion returned 402. That is a different boundary and cannot
justify skipping inventory here. No Rose agent executed this test, so a root
agent bug report is not applicable.

## Solution

Keep the exact non-2xx failure requirement and include the HTTP status plus at
most 500 characters of provider evidence, with the request credential redacted.
The existing registered inventory unit suite runs the actual blackbox entry in
fresh children with injected 401, 403, 429 and 503 catalog responses and refuses
any unexpected outbound request. It failed before the diagnostic change and
passed afterward; all rejections still exit nonzero and no key appears.
Backend typecheck, scoped ESLint and formatting passed. No model completion,
financial call, retry-policy or timeout change was needed.

This repairs the evidence boundary, not the original provider rejection.
Capture the exact CI response on its next authorized owning-gate execution;
do not convert this open cause into an external-provider waiver. Golden
reference: not applicable (no approval-gated hunk).

## Human feedback

The delegated scope required concrete check identities and evidence, retained
original failures, and prohibited blanket waivers or new financial tasks.

## Reusable lesson

Preserve redacted HTTP rejection evidence before classifying a live dependency failure.
