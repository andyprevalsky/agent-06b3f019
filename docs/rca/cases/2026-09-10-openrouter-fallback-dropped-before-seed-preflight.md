---
id: 2026-09-10-openrouter-fallback-dropped-before-seed-preflight
date: 2026-09-10
title: Benchmark seed rejected the OpenRouter Claude fallback that the running backend had already validated
surface: harness
component: benchmark-compute-token-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py _sync_compute_tokens did not carry the backend-validated OpenRouter fallback into back-end/scripts/seed-local.ts, whose missing-Claude branch accepted only ANTHROPIC_API_KEY
symptoms:
  - "SEED_ALLOW_MISSING_CLAUDE_CODE=1 requires a non-empty ANTHROPIC_API_KEY"
  - "RuntimeError: Benchmark run could not refresh local compute tokens"
  - smoke and AgentCard deploy lanes failed before any agent was created
tags:
  - benchmarks
  - seed-local
  - openrouter
  - claude-code
  - credential-preflight
sources:
  - PR #1302
repro: agents/tests/blackbox/benchmark.blackbox.py
status: open
---

## Problem

The 2026-09-10 `/deploy` smoke and AgentCard lanes both aborted before creating
an agent. Their independent logs ended at the same seed boundary:
`SEED_ALLOW_MISSING_CLAUDE_CODE=1 requires a non-empty ANTHROPIC_API_KEY`, then
`RuntimeError: Benchmark run could not refresh local compute tokens`. The
running local backend reported OpenRouter configured, and the checked-in
`back-end/.env` contained a non-empty `OPENROUTER_API_KEY` but no
`ANTHROPIC_API_KEY`.

The archive searches were `SEED_ALLOW_MISSING_CLAUDE_CODE requires non-empty
ANTHROPIC_API_KEY compute tokens benchmark`, `No claude_code integrations with
credentials found for Andy production E2B smoke`, and `OpenRouter configured
Anthropic fallback benchmark compute-token sync`. The incident is a relative,
not a recurrence: prior cases covered over-broad token gates and preflight/runtime
credential-route drift, but none recorded this OpenRouter-to-seed handoff.

## Diagnosis

`_has_usable_anthropic_api_key_fallback` correctly treats either a live shared
Anthropic key or `openrouterConfigured=true` as a usable Claude sandbox fallback;
`resolveClaudeCodeSandboxApiKey` uses that same OpenRouter path at runtime.
`_sync_compute_tokens` then set `SEED_ALLOW_MISSING_CLAUDE_CODE=1`, but
compute-token-only seed deliberately does not load `back-end/.env`, and the
runner did not copy either fallback key into its child environment. Even if the
OpenRouter key had been present, `seed-local.ts` revalidated only
`ANTHROPIC_API_KEY`. Thus two consumers of one readiness decision implemented
different accepted-provider sets, and the stricter downstream copy rejected a
runtime-valid configuration.

The pre-fix reproductions failed without network calls: the benchmark helper
regression reported `None == "sk-or-test-fallback"`, and
`cd back-end && npx tsx src/tests/blackbox/seed-local.part2.blackbox.ts` reported
`expected validation of the OpenRouter key`. The deepest owned cause is a
logical inconsistency in harness credential contracts: fallback readiness was
decided by one provider set, then independently reinterpreted by a narrower
provider set across a subprocess boundary.

The separate Claude Code E2B smoke failure is configuration state, not this
harness bug: its strict production sync found no eligible Andy `claude_code`
credential. This change does not alter that gate or production credential
selection.

## Solution

When missing-Claude tolerance has already been validated, `_sync_compute_tokens`
now carries only the configured `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY`
candidates from the backend env into the compute-token-only child.
`seed-local.ts` accepts either as the same Anthropic-compatible runtime fallback
and still fails closed when both are absent. No browser code, prompt, production
credential-selection rule, or Claude E2B skip behavior changed.

The permanent benchmark blackbox regression and the seed blackbox now pass. The
deploy-discovered `benchmark` domain also passed as a whole (1 domain, 0 failed,
54.6 seconds), closing the adversarial review's initial coverage objection. A
direct replay through `_sync_compute_tokens` against the failed
AgentCard run's isolated database also returned
`compute_token_sync_ok=True`. The case remains open until `/deploy` reruns the
exact unchanged smoke and AgentCard benchmark lanes; proxy and boundary tests do
not satisfy the benchmark outcome gate.

## Human feedback

The user explicitly rejected browser changes and re-scoped the work as a memory
PR. The credential fix therefore remained strictly in the non-browser benchmark
and seed harness.

## Reusable lesson

Carry a validated fallback capability across subprocess boundaries with the same provider set the runtime actually accepts, and fail closed only when every accepted provider is absent.
