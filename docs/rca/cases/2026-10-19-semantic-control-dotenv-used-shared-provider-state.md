---
id: 2026-10-19-semantic-control-dotenv-used-shared-provider-state
date: 2026-10-19
title: Standalone semantic controls inherited nonlocal database and wrote shared cooldowns
surface: harness
component: phone-semantic-control-runner
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: standalone semantic control runner loaded backend dotenv without explicit local database assertion
symptoms:
  - "Funded GPT API key backed off"
  - "Anthropic API key backed off"
  - "model=Integration operation=upsert"
tags:
  - test-isolation
  - dotenv
  - funded-key-cooldown
sources:
  - memory: .context/phone-harness/credential-semantic-before.log
  - memory: .context/phone-harness/credential-semantic-isolation-audit.json
repro: none-recorded
status: open
---

## Problem

Canonical real-model form-binding controls inherited nonlocal backend DATABASE_URL. At 00:20:24.863 and 00:20:25.819 UTC on October 19 they successfully updated existing GPT and Anthropic shared cooldown Integration rows. This violated the task's isolation requirement. No phone operation or credential decryption occurred in these controls. Provider responses were genuine quota failures, but a test was not authorized to persist production shared state.

## Diagnosis

Flow: standalone artifact runner → dotenv backend environment → canonical Rose wrapper → funded provider quota error → shared Integration upsert → ordinary callers skip those funded routes until expiry.

What: two shared cooldowns updated by a test. Where: .context/phone-harness/credential-form-semantic-check.ts had no database target guard. Why: canonical model invocation has database side effects, and dotenv implicitly supplied a nonlocal target. Proof: before log records successful upserts and exact until timestamps; read-only audit finds matching updatedAt and rateLimitedUntil on historical rows. Problem class: fixture environment mismatch at a side-effecting canonical client boundary.

GPT row 0e052f1e-0aec-4e8c-955c-4fba08b27a9f was created October 2, updated 00:20:24.863, expires 00:50:24.862. Anthropic row a31ded72-95e7-4812-90be-57aca1de55f8 was created October 2, updated 00:20:25.819, expires 00:50:25.818. Both reasons are RosePaymentRequiredError. At the 00:23:03.875 audit about 27m22s remained. Prior values were not captured, so deletion or reset is unsafe. Actual main workflow impact beyond route-skipping is not measured.

Archive searches used shared cooldown and production dotenv vocabulary; the October 2 stack-funded-key-cooldown-leaked-into-coverage-db case is a related isolation failure, but involved local coverage state rather than nonlocal controls. A later attempted guard installation used the wrong working directory and failed before a shell-following model invocation; that additional invocation read cooldowns and used Foundry. It did not intentionally restore state. No further calls are pending.

## Solution

Production source remains frozen. The artifact runner now rejects non-loopback DATABASE_URL before invoking the canonical model. Executed default-dotenv guard exits 1 with no model request in credential-semantic-local-guard.log. Explicit loopback victoria controls independently passed the positive form and all four negative controls in credential-semantic-local-after.log. No shared rows were reset or deleted. Keep this case open pending parent review, expiry confirmation, and a durable registered harness safeguard if this artifact becomes reusable. No product code workaround or global pricing change is proposed.

## Expiry verification

At 2026-10-19T00:51:36.048332Z, a production read-only SELECT of only these two rows' id, updatedAt and rateLimitedUntil confirmed both original cooldown deadlines had passed. Both rows still matched the original accidental writes; neither had a later update. Evidence: `.context/phone-harness/cooldown-expiry-result.json`. No production write, model call, phone action, authentication completion or worker restart occurred. Expiry is confirmed; the case remains open for review and the durable runner safeguard noted above.

## Human feedback

The user required that the change not affect main trajectories at all. The delegated task separately required read-only production access; that parent technical instruction is not additional human feedback.

## Reusable lesson

Assert an explicitly isolated database before invoking canonical model clients that can persist shared provider state.
