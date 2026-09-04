---
id: 2026-07-25-static-agentcard-credentials-died-when-provider-retired-api-keys
date: 2026-07-25
title: AgentCard retired API keys and admin JWTs, leaving three static credentials in our env as dead landmines
surface: back-end
component: agentcard-provider
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: AgentCard REST/API-key auth now returns 410 endpoint_retired; only OAuth client-credentials still mint a token
symptoms:
  - "Could not obtain an AgentCard Organization MCP access token"
  - "Invalid or expired organization token"
  - "410 endpoint_retired"
  - "API keys are retired. Exchange your OAuth client credentials for a token instead"
  - "agentcard_org_token_unavailable"
tags:
  - agentcard
  - oauth
  - credentials
  - env-vars
  - third-party-deprecation
  - mcp
  - jwt
sources:
  - memory:project_agentcard_companies_oauth_mcp
  - PR #1242
repro: back-end/src/tests/blackbox/agentcard-org-runtime.blackbox.ts
status: fixed
---

## Problem

A credential audit found that three AgentCard auth paths our repo still carried
were dead. The `sk_test_`/`sk_live_` API keys (`AGENTCARD_API_KEY` /
`AGENTCARD_API_KEY_LIVE`) now return `410 endpoint_retired` with
"API keys are retired. Exchange your OAuth client credentials for a token
instead". The admin-JWT path (`~/.agent-cards-admin.json` `.accessToken`, a
~24h WorkOS session) had expired on 2026-07-24. `AGENTCARD_MCP_ACCESS_TOKEN`
(a 30-day self-issued JWT in local `.env`) was expired and read by zero code.

## Diagnosis

The provider deprecated both API-key auth and the legacy REST admin endpoints,
so every static long-lived credential we held became permanently invalid at a
time we did not control. The only provider-supported auth left is OAuth
client-credentials: `POST https://api.agentcard.sh/api/v1/oauth/token` with
`AGENTCARD_ORG_OAUTH_CLIENT_ID` + `AGENTCARD_ORG_OAUTH_CLIENT_SECRET` (`acs_…`)
and mandatory `resource=https://mcp.agentcard.sh/mcp`, which returns a 1-hour
Bearer JWT. Production was already safe because `org-runtime.ts` auto-refreshes
that exchange (60s skew, single-flight) and the `acs_` secret is durable. The
owned exposure was the _residue_: dead static tokens and a `directAccessToken()`
fallback still sitting in configuration, plus `benchmark-float.ts` still hitting
the retired `/orgs/{id}/wallet[/test-fund]` REST endpoints — covered only by
mocked unit tests, so nothing failing would have told us.

## Solution

Standardize entirely on the auto-refreshing `acs_` client-credentials path and
delete the static landmines: remove `AGENTCARD_MCP_ACCESS_TOKEN` (zero readers),
retire the `sk_` keys and the dead `directAccessToken()` fallback that production
never reaches while client-creds are present, and either migrate
`benchmark-float.ts` onto MCP `get_company_wallet` via `callOrgTool` (as the live
`org-wallet-monitor.ts` already does) or delete it. AgentCard issues no long-TTL
tokens at all — every token is 1 hour — so a "long-lived env var" is not an
option and per-deploy rotation is unnecessary; the `acs_` secret is rotated only
through the AgentCard dashboard.

## Human feedback

The human framed the audit as "stale env vars break deploys" and asked for
long-lived credentials; the correction that came out of the investigation was that
no long-TTL token exists for this provider, so the answer is an auto-refreshing
client-credentials exchange rather than a longer-lived key. Writing production env
vars still requires explicit user approval.

## Reusable lesson

Prefer a self-refreshing client-credentials exchange over any static provider key,
and delete dead credentials from every `.env` and prod surface — a retired key
that only mocked tests exercise will fail silently until a live call needs it.

## Recurrence — 2026-09-03 (org MCP rejects the token-endpoint JWT)

`/deploy` Step 6a (`scripts/run-bench --local agent-payment-*`) failed while
seeding the payment fixture. The identical live probe against HEAD
`org-runtime.ts` failed, and the same probe passed after the fix:

```
npx tsx /tmp/probe-org-wallet.ts
# HEAD: WALLET_FAIL status=502 code=agentcard_org_token_unavailable
#       "Could not obtain an AgentCard Organization MCP access token"
# fix:  WALLET_OK livemode=false (sandbox) funded get_company_wallet
```

Owned first-bad boundary: `AgentCardOrgRuntime.fetchAccessToken` POSTed
`application/x-www-form-urlencoded` client credentials to the org token
endpoint, then handed the minted JWT to MCP SDK `initialize` / `tools/call`.
Live evidence on the Render org client:

1. Form-body client-credentials always returned HTTP 500 `Token grant failed`
   (the 6a error).
2. HTTP Basic sometimes minted a JWT with `tokenUse: org_client`, `scope: api`,
   and no `aud`. MCP rejected that JWT: `Invalid or expired organization token`.
3. MCP SDK `initialize` 401'd on a healthy `acs_…` secret. Direct JSON-RPC
   `tools/call` with `Authorization: Bearer <acs_…>` succeeded.

Why the 2026-07-25 guardrail missed it: unit tests mocked a successful JWT
exchange and never asserted the Bearer bytes against live `tools/call`, so the
auto-refresh path stayed green while MCP had already stopped accepting those
JWTs. `.env.example` already documented the `acs_…` secret as a direct bearer.

Fix: `getAccessToken()` returns `AGENTCARD_ORG_OAUTH_CLIENT_SECRET` (else a
non-`sk_` `AGENTCARD_ORG_MCP_ACCESS_TOKEN`). Default transport POSTs JSON-RPC
`tools/call` to `AGENTCARD_MCP_RESOURCE` and skips MCP `initialize`. Cemented by
`agentcard-org-runtime.blackbox.ts` (`tokenRequests === 0`, Bearer is the
secret) plus unit tests in `agentcard-org-runtime.test.ts` and
`agentcard-mcp-runtime-extras.test.ts`.

Local `.env` org OAuth (`sha16 6e63d4d747bd90c6`) was a different client than
Render (`sha16 e6435eec84afb6dd`) and could not `get_company_wallet`; that is a
fixture mismatch, not the auth-shape bug. Synced local from Render for the
live probe; `.env` is not committed.

Classification of this recurrence: `our-bug` /
`logical-inconsistency-in-harness-contracts` (we sent the wrong credential
shape to the provider MCP).
