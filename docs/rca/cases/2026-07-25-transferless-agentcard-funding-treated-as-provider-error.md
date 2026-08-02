---
id: 2026-07-25-transferless-agentcard-funding-treated-as-provider-error
date: 2026-07-25
title: A valid transferless funding_in_progress response was converted into a generic AgentCard provider error
surface: back-end
component: agentcard-org-mcp
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AgentCard organization funding parser — funding_in_progress was considered valid only when a transfer ID was present
symptoms:
  - AgentCard company funding returns funding_in_progress without a transfer ID
  - a valid pending funding response becomes a generic provider error
  - idempotent card creation cannot retry with the provider retryAfterSeconds
tags:
  - agentcard
  - funding
  - idempotency
  - provider-contract
  - retry
sources:
  - PR #864
repro: back-end/src/tests/blackbox/purchases.part4.blackbox.ts
status: fixed
---

## Problem

The production AgentCard provider can report `funding_in_progress` without a
transfer ID. The purchase path discarded that valid pending state as a generic
provider failure, so it could not retry the same idempotent card request.

## Diagnosis

The parser conflated two contracts: a transfer ID is required to confirm a
specific collection, but it is not required to recognize that funding is still
in progress. Requiring the identifier at the status boundary erased the
provider's retry delay and prevented the safe replay path.

## Solution

Preserve a typed `agentcard_company_funding_in_progress` result with
`retryAfterSeconds` even when no transfer ID exists. Retry the identical
idempotency key without inventing a transfer, while keeping transfer
confirmation mandatory when the provider supplies a real ID.

## Human feedback

None recorded.

## Reusable lesson

Do not require optional provider identifiers to preserve a valid pending state;
carry the typed status and retry metadata through the idempotent replay path.
