---
id: 2026-07-23-agentcard-transfer-id-field-alias-unparsed
date: 2026-07-23
title: The AgentCard org funding parser only accepted transfer_id/transferId, so a provider_transfer_id response became a 502
surface: back-end
component: agentcard-provider
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AgentCard org MCP funding response parser — it recognized only `transfer_id`/`transferId`, not `provider_transfer_id`
symptoms:
  - "AgentCard company funding is in progress without a transfer id"
  - "POST /api/purchases/mint returns 502"
  - AgentCard production abandonment benchmark fails after PR #859
tags:
  - agentcard
  - mcp
  - response-parsing
  - field-alias
  - 502
  - purchases
sources:
  - PR #861
repro: back-end AgentCard provider unit for provider_transfer_id responses
status: fixed
---

## Problem

The AgentCard production abandonment benchmark started failing after PR #859 merged.
The production AgentCard org MCP returned `funding_in_progress` carrying
`provider_transfer_id`; the backend parser accepted only `transfer_id` and
`transferId`, so it threw "AgentCard company funding is in progress without a transfer
id" and `/api/purchases/mint` returned 502.

## Diagnosis

A real, successful funding-in-progress response was discarded because the parser's
accepted key set was narrower than the provider's actual field naming. The parser then
downgraded a recoverable state (funding in progress, with a usable transfer id) into a
generic missing-transfer provider error, which erased the information needed to poll
or retry the transfer — so the caller saw a hard 502 for what was a normal
intermediate state.

## Solution

The parser now accepts snake_case and provider-prefixed transfer id fields from
AgentCard org MCP funding responses, and surfaces the real funding-in-progress transfer
id instead of downgrading to a generic missing-transfer error. Transfer lookup and
retry handling follow the alternate field names too. A focused regression unit covers
`provider_transfer_id` responses; purchases blackbox part5 passed 12/12 and backend
coverage passed 102/102 blackbox domains and 87/87 unit files. Shipped as a prod-gate
hotfix.

## Human feedback

None recorded.

## Reusable lesson

Accept every field-name variant a provider may emit and never downgrade a recognized
intermediate state to a generic error — the discarded identifier is what the retry
path needs.
