---
id: 2026-07-23-agentcard-transfer-id-only-parsed-from-top-level-aliases
date: 2026-07-23
title: AgentCard transfer-id extraction only read top-level aliases, so nested funding.transfer.id 502'd the mint
surface: back-end
component: agentcard-org-mcp
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: src/providers/card-provider/agentcard-org-mcp.ts — transfer-id extraction matched only top-level aliases (transfer_id, transferId, provider_transfer_id, providerTransferId)
symptoms:
  - "AgentCard company funding is in progress without a transfer id"
  - "/api/purchases/mint returned 502 after approval"
  - AgentCard returns funding_in_progress with the transfer id nested under funding.transfer.id
tags:
  - agentcard
  - mcp
  - purchases
  - response-parsing
  - prod-502
sources:
  - PR #863
repro: back-end/src/tests/unit/agentcard-org-mcp-provider.test.ts
status: fixed
---

## Problem

Production AgentCard returned `funding_in_progress` for the company flow without
any of the top-level transfer-id aliases the backend recognized
(`transfer_id`, `transferId`, `provider_transfer_id`, `providerTransferId`). The
backend raised `AgentCard company funding is in progress without a transfer id`
and `/api/purchases/mint` returned 502 _after_ the user had already approved the
purchase.

## Diagnosis

The transfer-id extraction was a flat lookup over a fixed list of top-level key
aliases. The provider's company-flow funding gate returns the id in a nested
container such as `funding.transfer.id`, which no alias matched, so a
structurally valid response was read as "no transfer id" and turned into a hard
error at the funding gate. The deeper cause is a parser coupled to one observed
response layout for a third-party payload we do not control: every new shape the
provider emits becomes a post-approval 502 for the user. Aggravating factor — the
failure lands after approval, so the user has already committed.

## Solution

Broadened AgentCard organization MCP transfer-id extraction to parse nested
transfer containers (e.g. `funding.transfer.id`), additional common transfer-id
aliases, and a labeled-text fallback, while explicitly _not_ treating a generic
`funding.id` as the company transfer id (which would mint against the wrong
identifier). Regression coverage added for nested and text-form
funding-in-progress transfer ids in
`src/tests/unit/agentcard-org-mcp-provider.test.ts`, plus reruns of the AgentCard
MCP runtime, wallet-funding, and purchase-reconcile unit suites.

## Human feedback

None recorded. The PR does note an unrelated adjacent pre-existing failure it did
not touch: `reconcileFailedPurchaseFundingReclaims clears on consumed-during-reclaim`
expected `CLEARED` but got `FUNDING_RECLAIM_FAILED` in
`src/tests/unit/purchase-cleanup.test.ts`.

## Reusable lesson

When parsing a third-party payload you do not control, search nested containers
and aliases rather than a fixed top-level key list — and never widen the match to
a generic id that could point at the wrong entity.
