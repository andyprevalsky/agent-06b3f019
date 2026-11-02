---
id: 2026-10-28-codex-fast-mode-routed-through-demo-cache-proxy
date: 2026-10-28
title: Codex Fast Mode routed sandboxes through the Rose demo-cache proxy instead of Codex's native speed
surface: cross
component: codex-code
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/e2b.ts createCodexCodeSession injected CODEX_FAST_MODE_PROXY_URL (derived from FAST_MODE_ANTHROPIC_PROXY_URL) and ws-server pointed chatgpt_base_url at a local proxy to /codex-proxy, while the query box's Fast/Ultrafast choice never reached Codex
symptoms:
  - Codex calls go through ngrok / /codex-proxy
  - Cloudflare 403 on proxied Codex calls
  - query-box Ultrafast has no effect on Codex code agents
  - Normal speed Codex sessions still start on the fastest tier
tags:
  - codex
  - fast-mode
  - demo-cache
  - service-tier
sources:
  - task User Scale Bug Bash lane S30 (parent thread thr_1981ff79aa724ae59870f1829121c7e1)
repro: e2b-templates/codex-code/app-server.test.mjs
status: fixed
---

## Problem

Andy directed (2026-10-28) that Codex must never route through our proxy, must
never use the Fast Mode / DEMO cache, and must start in its native fast mode
when the query box is on Fast, or its ultrafast mode on Ultrafast.

Before this change:
- The backend gave every Codex E2B sandbox a `/codex-proxy` URL derived from
  `FAST_MODE_ANTHROPIC_PROXY_URL` (ngrok locally, the backend in prod).
- ws-server ran a local proxy and set `chatgpt_base_url` /
  `model_provider="fastmode"` to it, so Codex traffic and cache
  reads/writes/ordinals went through Rose.
- The query box sent only a `fast_mode_cache_enabled` boolean. The Fast vs
  Ultrafast choice stayed in the browser.
- ws-server started every new session on the fastest tier the model offers,
  whatever the user picked, including Normal.

## Diagnosis

The Codex 0.159.0 model catalog, read through `model/list`:
- With ChatGPT auth, `gpt-5.6-terra` (our model) offers only `priority`
  ("Fast"); `gpt-6.1-sol` (catalog default) offers `priority` and `ultrafast`.
- Without auth, only `priority` is listed.

The Codex source (`features/src/lib.rs`, `core/src/config/mod.rs`) gates
`ultrafast` behind `features.ultrafast_mode` (on by default). Azure accepts the
`priority` tier but silently serves `ultrafast` as standard.

Local repro: three new real-process and fixture cases in `app-server.test.mjs`:
- requested speed → native tier;
- graceful degradation;
- no proxy in ws-server.

All three fail on the old ws-server and pass after (25/25, 5 consecutive runs).

## Solution

- **Removed:**
  - the `/codex-proxy` route, `codexProxyCore`, the Codex demo-cache domain
    exports and the request dumper;
  - `buildFastModeCodexEnv`;
  - the Codex proxy env, its `run.sh` / runner exports and the Vite dev proxy;
  - ws-server's local proxy and `chatgpt_base_url` / `fastmode` provider
    overrides.
- **Kept:** the demo cache for Claude Code (`/anthropic-proxy`, still gated by
  `CLAUDE_CODE_FAST_MODE_ENABLED`), DEMO, sim and mass-agent flows.
- **Speed:**
  - The FE sends `fast_mode_speed` (`fast` | `ultra`, from the saved
    preference; Ultrafast by default) with Fast Mode.
  - The backend stores it on the new nullable `Agent.fastModeSpeed` column.
  - At Codex session create it resolves the agent's speed (or its tree root's)
    with `codexSpeedFor`: off → `standard`, `fast` → `priority`,
    `ultra` → `ultrafast`, and Fast Mode on with no speed → `priority`.
  - The result is passed as `CODEX_SPEED`.
- **ws-server:**
  - It honours `CODEX_SPEED` on the native tier.
  - Ultrafast on a model without that tier runs on the catalog model that
    offers it, default first.
  - Unavailable tiers degrade to slower ones only.
  - The Azure funded fallback runs `priority`.
- **Unchanged:** user OAuth first and the Azure fallback.

Inverted regressions:
- demo-cache blackbox: `/codex-proxy` returns 404 even when a Codex-shaped cache
  row exists;
- unit test: no proxy, cache or `chatgpt_base_url` anywhere in the Codex path;
- structural test: no Codex proxy router;
- `run.sh` contract: never exports a Codex proxy URL;
- multi-instance ordinals and isolation cases: Anthropic only.

Real E2B proof:
- Fast: backend `codexSpeed=priority`, Codex `effective_settings`
  `{model: gpt-5.6-terra, speed: priority}`, smoke PASS.
- Ultrafast: `codexSpeed=ultrafast`, Codex
  `{model: gpt-6.1-sol, speed: ultrafast}`, smoke PASS.

10k-agent behaviour: Codex traffic no longer passes through the backend at all,
which removes a per-turn request fan-in. Speed resolution costs at most two
indexed Agent reads per session.

## Human feedback

Andy (2026-10-28): Codex never through our proxy; Fast → Codex fast,
Ultrafast → Codex ultrafast; no demo cache for Codex.

## Reusable lesson

A user-visible speed control must reach each provider as that provider's native setting, end to end, with a real-sandbox check of the effective value.
