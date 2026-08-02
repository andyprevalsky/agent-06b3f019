---
id: 2026-06-22-openrouter-402-with-empty-compute-token-pool-broke-every-agent
date: 2026-06-22
title: OpenRouter 402 plus an empty compute-token pool made 100% of prod agents fail while `/health` stayed 200
surface: back-end
component: rose-client
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: OpenRouter returned HTTP 402 "Insufficient credits" for every model in pool rose-1-lite, and compute-token rotation ended with no usable token
symptoms:
  - "402 Insufficient credits"
  - "No chat compute token available after rotation; allowing waterfall"
  - "All N waterfall models failed"
  - prod benchmark 0/18 passed while GET /health returns 200
tags:
  - rose-waterfall
  - openrouter
  - compute-tokens
  - prod-outage
  - billing
sources:
  - memory:project_prod_llm_outage_jun2026
repro: none-recorded
status: fixed
---

## Problem

From roughly 2026-06-19 to 2026-06-22, prod agent and chat execution was totally
broken while every health signal looked fine: `/health` returned 200 and DB/HTTP
were healthy. A full prod benchmark run (`runs/20260622_204613_all.json`) scored
0/18 passed (plus 2 minted tasks skipped as local-only).

## Diagnosis

Render logs from the `RoseWaterfall` and `ChatComputeRotation` components showed
two stacked failures. OpenRouter returned HTTP 402 "Insufficient credits" for
every model in pool `rose-1-lite`
(`google/gemini-3-flash-preview`, `moonshotai/kimi-k2.5`) — present since at
least 2026-06-19. Meanwhile compute tokens failed and rotated to empty: the test
user's Claude token was served then rotated away on 401/403, the GPT token also
failed, and the fall-through hit the 402 waterfall, logging
"No chat compute token available after rotation; allowing waterfall" followed by
"All N waterfall models failed". Because every agent and chat path routes through
Rose completions, that made 100% of agents fail. Critically, the downstream
symptoms were misleading: browser/auth benchmark tasks failed with
"Expected auth_assistance/write_lock/approval but none triggered", which looks
like a browser-auth bug but was simply agents never executing far enough. The
owned gap is that no health signal covered the LLM layer at all — a fully dead
completion path still reported a green service.

## Solution

Restored by injecting 2 long-lived Claude OAuth tokens into the `claude_code`
**pool** (`poolingEnabled=true`) via `back-end/scripts/sync-pool-tokens.ts`
(bootstrap by flipping `poolingEnabled` on decryptable rows first, since the
script needs existing pool slots), and re-syncing the Codex token via
`sync-codex-token.ts` with `CODEX_TOKEN_POOLING_ENABLED=true`. A pool Claude
token needs a non-empty `refreshToken` in its envelope
(`computeCredentials.hasUsableClaudePoolEnvelope`) — long-lived tokens have none,
so a placeholder is required. Prod smoke after the fix was 5/6. Follow-up: a
direct Anthropic API-key tier was added to the TS Rose client (`client.ts` tier
2.5, ahead of the OpenRouter waterfall) as a funded default, pending the env var
on Render and Fly. The same drought empties the GPT Code pool and 500s the
`codex-code` backend blackbox smoke ("no available pool tokens").

## Human feedback

The human's rule was invoked directly: provider credit/billing failures are a
billing escalation, and benchmark failures must not be treated as code bugs until
the LLM layer is confirmed up — restore healthy pool tokens first.

## Reusable lesson

When many unrelated benchmarks fail with plausible domain-specific errors, verify
the LLM layer is actually serving before diagnosing any of them — a green
`/health` says nothing about provider credits or the compute-token pool.
