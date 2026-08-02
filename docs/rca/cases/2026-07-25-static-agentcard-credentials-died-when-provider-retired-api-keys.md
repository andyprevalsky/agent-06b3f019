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
  - "410 endpoint_retired"
  - "API keys are retired. Exchange your OAuth client credentials for a token instead"
  - "~/.agent-cards-admin.json .accessToken expired (WorkOS session, ~24h)"
tags:
  - agentcard
  - oauth
  - credentials
  - env-vars
  - third-party-deprecation
sources:
  - memory:project_agentcard_companies_oauth_mcp
repro: none-recorded
status: mitigated
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
