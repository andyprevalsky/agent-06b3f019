---
id: 2026-07-13-codex-sandbox-threw-instead-of-falling-back-to-the-openai-key
date: 2026-07-13
title: The Codex E2B session threw when every pooled OAuth token was rate-limited instead of falling back to the funded OpenAI key
surface: back-end
component: e2b-codex-session
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "back-end/src/providers/e2b.ts:createCodexCodeSession — threw on a null credentialMeta instead of injecting OPENAI_API_KEY"
symptoms:
  - "usage_limit_reached stalls the deploy Codex E2B smoke"
  - "fetchGptCodeCredentialsWithMeta returns null once rateLimitedUntil filters every pool token"
  - codex-code session creation fails while the Rose path still works
tags:
  - codex
  - e2b
  - rate-limit
  - fallback
  - deploy-gate
sources:
  - memory:project_codex_e2b_openai_key_fallback
repro: back-end/src/tests/blackbox/codex-code.blackbox.ts
status: fixed
---

## Problem

The deploy's Codex E2B smoke stalled on `usage_limit_reached`. The two GPT/Codex
auth paths behaved differently under the same exhaustion: Rose in-process
completions (`agents/providers/rose/client.py`,
`back-end/src/providers/rose/client.ts`) already fall back from the compute token
to the funded `GPT_API_KEY` on 401/403/429, but
`POST /api/codex-code-session/create` hard-failed.

## Diagnosis

`fetchGptCodeCredentialsWithMeta` filters out rate-limited pool tokens via its
`rateLimitedUntil` SQL filter, so when the Codex OAuth token is exhausted it
correctly returns `null`. `createCodexCodeSession` then **threw** on that null.
The capability to continue already existed on both sides of the boundary: the
sandbox ws-server (`e2b-templates/codex-code/ws-server.mjs:384`) supports API-key
mode via `codex login --with-api-key` reading `OPENAI_API_KEY` — the backend
simply never injected it. The deeper cause is that one auth surface (Rose) owned a
fallback policy that its sibling surface (Codex CLI in E2B) did not, so exhaustion
handling depended on which path you happened to be on.

## Solution

Added the pure exported `resolveCodexCodeAuthEnvs(credentialMeta, openaiApiKey)`,
mirroring the existing `resolveClaudeCodeAuthEnvs`: OAuth `credentialMeta` →
`CODEX_AUTH_JSON`; else funded key → `OPENAI_API_KEY`; else throw.
`createCodexCodeSession` sources the fallback from `process.env.GPT_API_KEY` — the
same funded key the Rose clients use — so both paths now degrade identically.
Tests added in `back-end/src/tests/blackbox/codex-code.blackbox.ts`.

Caveat recorded at the time: true end-to-end proof needs the live Codex E2B smoke
(services + OpenAI credits). With a plain API key there is no fast-mode proxy, so
the CLI hits OpenAI directly with `CODEX_MODEL` (`gpt-5.6-terra`); if that alias is
not valid on the direct OpenAI API that is a separate follow-up.

## Human feedback

None recorded.

## Reusable lesson

When two code paths consume the same exhaustible credential, give them the same
fallback resolver — a null from a rate-limit-aware credential fetch means "use the
next credential", never "throw".
