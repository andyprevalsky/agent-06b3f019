---
id: 2026-07-25-agentcard-v1-wallet-endpoint-retired-410
date: 2026-07-25
title: AgentCard's v1 wallet endpoints were retired (HTTP 410), breaking float provisioning until it moved to v2 OAuth client credentials
surface: back-end
component: agentcard-integration
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "AgentCard v1 /orgs/:id/wallet and /wallet/test-fund — now return HTTP 410 endpoint_retired"
symptoms:
  - "HTTP 410 endpoint_retired from /orgs/:id/wallet"
  - "HTTP 410 from /orgs/:id/wallet/test-fund"
  - "sandbox float cannot be topped up programmatically"
  - "ensureAgentCardSandboxFloat cannot restore its $100 floor"
tags:
  - agentcard
  - api-deprecation
  - oauth
  - sandbox-float
  - shared-resource
sources:
  - PR #871
  - memory:project_temporal_cutover_first_prod_deploy
repro: none-recorded
status: fixed
---

## Problem

AgentCard's v1 wallet endpoints (`/orgs/:id/wallet` and `/wallet/test-fund`) were
retired and now return HTTP 410 `endpoint_retired`, so float provisioning — including
`ensureAgentCardSandboxFloat`'s $100 floor — failed outright during the 2026-07-25
prod deploy.

## Diagnosis

The provider removed the version of the API we depended on, and the replacement is not
a like-for-like swap: v2 requires OAuth client-credentials auth and has NO programmatic
sandbox top-up at all. So a capability the harness relied on (self-healing the sandbox
float) no longer exists in the new API surface. Compounding it, the sandbox float is a
SHARED resource across workspaces, so concurrent deploys in other workspaces drain it
and there is no automated way to refill.

## Solution

Float provisioning now goes through v2 OAuth client credentials —
`org-runtime.callOrgTool('get_company_wallet')` using
`AGENTCARD_ORG_OAUTH_CLIENT_ID`/`SECRET`. A depleted SANDBOX float requires a manual
dashboard/USDC deposit, which is why the local AgentCard lifecycle gate was skipped on
this deploy while the prod lifecycle (live float) passed end to end: reserve → capture
→ abandon → reclaim → refund with no leaked money.

## Human feedback

The human authorized skipping the local AgentCard lifecycle gate for this deploy on the
grounds that a depleted sandbox float is an external funding blocker, not a code defect
— explicitly scoped, alongside the codex-code blackbox and claude-code smoke skips, and
conditional on the prod lifecycle gate passing.

## Reusable lesson

When a vendor retires an API version, check whether the replacement still offers the
capability you automated on — a 410 can mean "re-auth and retry" for one call and
"this capability no longer exists" for the next.
