---
id: 2026-10-26-sandbox-subscription-api-key-insert-lost-error-details
date: 2026-10-26
title: Sandbox subscription API-key insert failed without retained error details
surface: back-end
component: supabase-api-keys
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Supabase RoseApiKey insert returned an error that was stringified as object Object
symptoms:
  - Error creating API key during a sandbox subscription webhook
  - Underlying Supabase error code and details absent from the retained log
tags:
  - subscription
  - api-key
  - sandbox-benchmark
  - missing-error-details
sources:
  - commit f26833061fa17956f61dab133093515c6f009879
  - plan:.context/rca-integrated-bench-triage/api-key-attribution.txt
repro: none-recorded
status: open
---

## Problem

The integrated local smoke run logged `Error creating API key` at
20:40:51.055Z on October 26. The structured error had become `[object Object]`.
The new-user payment journey nevertheless passed, and the native purchase,
card closure, attention and cleanup assertions succeeded. These receipts do
not establish that a default Rose API key was created.

## Diagnosis

Read-only investigation attributed the event to the sandbox subscription
checkout webhook: handleCheckoutSessionCompleted calls
activateSubscriptionForUser, which resolves the subscription gate before
calling ensureRoseApiKeyForUser. That helper inserts into Supabase RoseApiKey,
logs String(insertError), and returns without throwing when insertion fails.
The webhook can therefore succeed after an auxiliary key-creation failure.

The adjacent checkout, subscription and gate events support attribution to
agent 283b093d-a72e-492e-82d6-5b00b0d50403. The error carries no request ID,
and no retained provider error code or later successful key creation proves
its underlying cause or recovery. Do not infer a schema, credential, permission
or provider fault. This was not established as an intentional negative control.

Evidence is retained in the run's logs/backend.log at line5201, its indexed
native run bundle, and .context/rca-integrated-bench-triage/api-key-attribution.txt.
Archive searches for RoseApiKey, subscription webhook and Error creating API key
found no exact prior case.

## Solution

No runtime repair is claimed. The bounded investigation used existing logs and
source only, without provider queries, DB changes or reruns. The original insert
failure has no causal red/green reproduction. Preserve it as an open evidence
gap; the passing payment benchmark does not certify API-key availability.
The planner-context fix and its independent captured-case proof are separate.

## Human feedback

The coordinating agent requested bounded read-only attribution while final
deployment gates ran, prohibited speculative repairs, and required preserving
uncertainty. No user waiver or assertion that the API-key error recovered was
given.

## Reusable lesson

Retain structured provider error details and distinguish an auxiliary provisioning result from the successful operation that called it.
