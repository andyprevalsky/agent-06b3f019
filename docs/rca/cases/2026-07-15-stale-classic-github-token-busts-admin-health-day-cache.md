---
id: 2026-07-15-stale-classic-github-token-busts-admin-health-day-cache
date: 2026-07-15
title: A stale classic `ghp_` GitHub token made one velocity sub-fetch `error`, which deleted the admin-health day cache
surface: back-end
component: admin-health
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: local back-end/.env GITHUB_TOKEN — a stale classic `ghp_` token 404s on the default `ADMIN_HEALTH_GITHUB_REPO`
symptoms:
  - "admin-health blackbox fails: Same-day weekly requests must reuse the backend day cache"
  - "GitHub 404 on Rose-Ai-Labs/rose"
  - second same-day weekly request returns a new generatedAt
tags:
  - admin-health
  - github-token
  - cache-invalidation
  - blackbox
  - deploy-gate
sources:
  - memory:project_admin_health_github_codex_env_gotchas
repro: none-recorded
status: fixed
---

## Problem

During the AgentCard payment `/deploy` (2026-07-15), the admin-health blackbox
assertion "Same-day weekly requests must reuse the backend day cache" failed:
the second same-day `weekly` request returned a fresh `generatedAt` instead of
the cached one, so the cache was clearly not being reused.

## Diagnosis

`getAdminHealth` (`back-end/src/domains/admin-health/service.ts`) does not merely
skip writing the day cache when a response is not cacheable — it **DELETES** the
existing entry when `isCacheableAdminHealthResponse` is false. That makes the
second same-day request regenerate, mint a new `generatedAt`, and fail the test.

Cacheability busts if **any** velocity sub-fetch has status `'error'`. Note the
asymmetry that made this confusing: `'unavailable'` / not-configured is still
cacheable; only `'error'` busts it.

The `'error'` came from the environment, not the code. The local `GITHUB_TOKEN`
was a stale classic `ghp_` token, which 404s on `Rose-Ai-Labs/rose` — the default
value of `ADMIN_HEALTH_GITHUB_REPO`, which is unset on Render. That produced
`dev.github` status `error`, which deleted the day cache.

## Solution

Mirror prod's fine-grained `github_pat_…` token (length 93) from Render into
`back-end/.env`. Verify a token before blaming code:
`curl -H "Authorization: Bearer $TOK" .../repos/Rose-Ai-Labs/rose/commits?per_page=1`
must return 200.

To identify _which_ field busts the cache next time, call `getAdminHealth('weekly')`
and `isCacheableAdminHealthResponse` directly against the local DB rather than
inferring from the failing assertion.

## Human feedback

None recorded.

## Reusable lesson

When a same-day cache-reuse test fails, check which sub-fetch reported status
`'error'` — a stale credential in one sub-fetch can delete the whole cache entry.
