---
id: 2026-10-28-codex-funded-fallback-billed-unfunded-openai-key
date: 2026-10-28
title: Codex sandbox funded fallback billed the unfunded OpenAI GPT_API_KEY instead of our Azure credits
surface: harness
component: codex-code-ws-server
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/claudeCodeSandboxAuth.ts resolveCodexCodeAuthEnvs injected GPT_API_KEY as the Codex funded key, while the Rose router already serves the same models from funded Azure Foundry deployments
symptoms:
  - "Quota exceeded. Check your plan and billing details."
  - Codex E2B smoke SKIPPED (both credential paths out of funds)
  - Codex code agents fail when the user's ChatGPT plan is exhausted
tags:
  - codex
  - azure
  - foundry
  - fallback
  - e2b
sources:
  - task User Scale Bug Bash lane S23 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
  - PR #1605
repro: e2b-templates/codex-code/app-server.test.mjs
status: fixed
---

## Problem

PR #1605 restored the Codex OAuth → funded-key runtime fallback, but the funded
key was `GPT_API_KEY`, an OpenAI API org with no credits. Andy won't top it up.
In a real sandbox the fallback ran and failed with "Quota exceeded. Check your
plan and billing details." Any user whose ChatGPT plan was exhausted, or who had
no ChatGPT login, got no Codex run. Meanwhile the Rose router already serves
GPT models from Azure Foundry deployments funded by our Azure credits.

## Diagnosis

Azure resources, read through the data plane on 2026-10-28; there are no ARM
credentials on the box:

- rose-foundry-westus (West US):
  - `gpt-5.6-terra` answers on the Responses API, the same model the Codex
    sandbox uses (`CODEX_MODEL`).
  - Rate limits: 10M tokens/min and 10k requests/min.
  - Accepts tools, `store:false`, encrypted reasoning and every service tier.
- a-4989-resource: `gpt-5.3-codex` and `gpt-6.1-terra` answer; its other
  deployments return "Insufficient quota".
- rose-foundry-southcentralus: `gpt-6-sol`, `gpt-6.1-sol` and `gpt-5.6-luna`.

Codex supports Azure as a model provider over the Responses wire API
(`codex/codex-rs/model-provider-info` Azure tests), sending
`Authorization: Bearer <AZURE_OPENAI_API_KEY>`. Bearer works on all three
resources. The Codex 0.159.0 CLI (the E2B template version) ran a tool-using
task against westus `gpt-5.6-terra` locally and wrote the expected file.

Local repro: the real-process app-server fallback case in `app-server.test.mjs`
now requires the azure provider: no `codex login`, provider `-c` flags, the
`AZURE_OPENAI_API_KEY` env, and resume on the Azure deployment.
- Before the fix, the old ws-server failed it, along with the oauth-feedback
  replays (8 failures).
- After the fix it passes 22/22 on 5 consecutive runs.

## Solution

- Backend: `resolveCodexAzureFunding()` picks the existing `AZURE_FOUNDRY_*`
  region whose host is rose-foundry-westus (overridable with
  `CODEX_AZURE_FOUNDRY_HOST` / `CODEX_AZURE_DEPLOYMENT`). No new secret is
  needed.
- `resolveCodexCodeAuthEnvs`:
  - User OAuth stays primary.
  - Alongside it, or alone when there is no login, it injects
    `AZURE_OPENAI_API_KEY`, `CODEX_AZURE_BASE_URL` and `CODEX_AZURE_MODEL`.
  - `GPT_API_KEY` no longer reaches any Codex sandbox.
- E2B and inspect sandboxes use it; Codex availability (C15 fall-over) checks
  Azure funding. Local-device sessions never receive a funded key.
- ws-server (both transports):
  - The funded path selects `model_provider="azure"` with `-c` flags
    (`base_url`, `env_key`, `wire_api="responses"`) and the Azure deployment as
    the model, and removes the ChatGPT `auth.json`.
  - `auth_fallback` keeps `to:"openai_api_key"` (the backend contract) and adds
    `funded_provider:"azure"`.

Real E2B sandbox with an unusable user OAuth credential: the OAuth turn hit
"You've hit your usage limit", then `auth_fallback` (azure), then the same turn
completed on Azure `gpt-5.6-terra`. The Codex E2B smoke PASSES; it previously
SKIPPED. With a working OAuth credential it still completes on OAuth.

10k-agent behaviour: one Azure deployment at 10M tokens/min funds every
OAuth-less or exhausted session; there is no per-session state. Azure 429s
surface as ordinary turn errors.

## Human feedback

Andy (2026-10-28): won't top up the OpenAI API account; bill the Codex funded
fallback to Azure credits.

## Reusable lesson

A funded fallback must name the provider that is actually funded; when billing moves, move every consumer of the old key with it.
