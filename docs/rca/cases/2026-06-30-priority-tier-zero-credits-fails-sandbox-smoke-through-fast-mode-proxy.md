---
id: 2026-06-30-priority-tier-zero-credits-fails-sandbox-smoke-through-fast-mode-proxy
date: 2026-06-30
title: Sandbox smoke failed because the local box's Anthropic org has 0 credits on the priority "fast mode" tier the proxy routes to
surface: back-end
component: sandbox-smoke
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: run.sh fast-mode proxy export — buildFastModeAnthropicEnv injects ANTHROPIC_BASE_URL pointing at the priority tier, which this org has at 0 tokens/min for opus-4-8
symptoms:
  - '429 "Usage credits are required for fast mode"'
  - "claude-code blackbox: Session started… then 240s timeout"
  - "codex blackbox: output did not include CODEX_E2B_DONE"
tags:
  - deploy
  - anthropic
  - fast-mode
  - e2b
  - rate-limit
  - opus
sources:
  - memory:project_opus48_fastmode_credits_deploy
repro: back-end/src/tests/blackbox/claude-code.blackbox.ts
status: mitigated
---

## Problem

During `/deploy`, the `claude-code` and `codex-code` blackbox **real-E2B sandbox
smoke** subtests failed locally: claude showed "Session started… then 240s
timeout", codex reported output that "did not include `CODEX_E2B_DONE`".

## Diagnosis

Neither E2B nor the tokens were at fault — the E2B sandbox booted fine and the
boundary tests passed. The agent/sandbox LLM call runs on **Opus 4.8**, because a
change on main defaulted new agents to `rose-1-ultra`
(`schema.prisma` `model @default("rose-labs/rose-1-ultra")`). This machine's
Anthropic org (`03e784fd-68ab-473e-afbe-18cf329e9d9b`) has a **0 tokens/min limit
on the priority / "fast mode" tier** for `claude-opus-4-8`, so those calls return
`429 "Usage credits are required for fast mode"`. Standard-tier opus-4-8 works
fine on the same box (proven via a direct API call); only the priority tier is at
zero, and the priority tier is not self-enableable in
`console.anthropic.com/settings/limits`.

The reason the sandbox hit the priority tier at all: `run.sh` exports
`FAST_MODE_ANTHROPIC_PROXY_URL` / `FAST_MODE_CODEX_PROXY_URL` (~line 840) and
`buildFastModeAnthropicEnv` injects `ANTHROPIC_BASE_URL=<local fast-mode proxy>`
into the sandbox, routing the CLI's Opus calls through priority. So a
local-only routing decision silently changed which quota the smoke test consumed.

## Solution

Local-only mitigation, deliberately **not shipped**: a `DISABLE_FAST_MODE_PROXY=1`
gate on run.sh's export, then `DISABLE_FAST_MODE_PROXY=1 bash scripts/run.sh --benchmark`
and re-running the two domains one at a time (the runner takes ONE domain arg) —
both passed on the standard tier. The run.sh edit was then reverted so the PR
stayed clean. In CI/prod the org has the credits, so this is a local-box-only
condition.

## Human feedback

None recorded.

## Reusable lesson

When sandbox smoke times out with no sandbox error, check which Anthropic tier the
call was routed to — a local fast-mode proxy can send it to a priority tier the
box's org has at zero credits, and standard tier works fine.
