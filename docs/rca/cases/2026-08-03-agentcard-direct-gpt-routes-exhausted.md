---
id: 2026-08-03-agentcard-direct-gpt-routes-exhausted
date: 2026-08-03
title: AgentCard direct GPT routes exhausted quota while Gemini fallback was malformed
surface: harness
component: agentcard-deploy-gate
classification: third-party-failure
problem_class: fixture-environment-data-mismatch
first_bad_boundary: external OpenAI API and GPT OAuth services rejected their direct compute requests for exhausted balance or usage quota
symptoms:
  - 'OpenAI Responses "insufficient_quota" / "credit_balance_exhausted"'
  - '"You have no credits remaining"'
  - 'GPT OAuth HTTP 429 "usage_limit_reached"'
  - '"LLM call failed 3 consecutive times: RoseAllFailed: All 2 waterfall models failed"'
tags:
  - agentcard
  - compute-tokens
  - openai
  - gpt-oauth
  - billing
sources:
  - PR #927
  - agent 172d2322-17fe-408e-b9bb-d4b0b2f236c9
  - agent 1c01396a-6db5-4fa7-b3d8-0f6e5bb3d7bb
repro: none-recorded
status: open
---

## Problem

The first required local AgentCard lifecycle run scored 1/4. In
`agent-payment-idempotent-abandonment`, agent
`172d2322-17fe-408e-b9bb-d4b0b2f236c9` successfully requested approval, minted
a card ending `0888`, and then encountered repeated provider failures during
later execution. GPT OAuth returned HTTP 429 `usage_limit_reached` with a reset
roughly 491,000 seconds away. OpenAI Responses separately returned
`insufficient_quota`, `credit_balance_exhausted`, and `You have no credits
remaining`.

Those failures do not by themselves explain the whole task or gate outcome. The
same runs also exercised a funded Gemini fallback that rejected an internally
inconsistent tool-result name; that owned bug is recorded in
`2026-08-03-openrouter-tool-result-name-mismatched-function-call`.

## Diagnosis

The direct GPT routes failed at their external provider boundaries because the
available API balance and OAuth allowance were exhausted. The gate seeded GPT
compute and excluded the Anthropic family, but it did not pin every request to
GPT; Gemini remained a permitted waterfall route. Therefore the evidence proves
direct-route exhaustion, not that an unfunded GPT-only gate was the sole reason
the benchmark failed.

This is related to
`2026-07-19-deploy-gates-hard-require-codex-tokens-no-task-uses`, where gate
credential preconditions were broader than task usage, and to
`2026-06-22-openrouter-402-with-empty-compute-token-pool-broke-every-agent`.
Neither is an exact recurrence: this run acquired credentials, reached payment
behavior, and had an additional funded provider route whose request was malformed
by owned code.

## Solution

No code workaround is proposed for the externally exhausted GPT routes. The
owned Gemini message-contract defect is fixed separately. The exact four-task
command was rerun unchanged and passed 4/4, proving the funded fallback is
sufficient for this gate. If direct GPT capacity is required for another
workload, replenish the OpenAI API balance or provide a GPT OAuth pool token with
available quota; do not skip tasks or relax evaluators.

The exact run command is:

```bash
CONDUCTOR_WORKSPACE_NAME=dodoma ROSE_EXCLUDE_ANTHROPIC_FAMILY=1 SEED_REQUIRE_COMPUTE_TOKEN_TYPES=gpt BENCHMARK_SKIP_WMH_BUILD=1 bash scripts/run-deploy-stage agentcard-lifecycle -- bash scripts/run-bench --local agent-payment-test-shop agent-payment-setup-resume agent-payment-idempotent-abandonment agent-payment-abandonment --bootstrap --base-port 62000 --max-concurrency 1 --no-dashboard
```

The initial failing run artifact is
`agents/benchmarks/runs/20260804_051258_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json`.
The passing rerun artifact is
`agents/benchmarks/runs/20260804_061229_agent-payment-test-shop,agent-payment-setup-resume,agent-payment-idempotent-abandonment,agent-payment-abandonment.json`.
Direct-route capacity was not restored or reverified, so this third-party case
remains open even though it no longer blocks the AgentCard gate.

At 10,000 agents, direct-route exhaustion requires aggregate capacity planning
and bounded credential rotation rather than per-agent retries that hide the
provider state.

## Human feedback

None recorded.

## Reusable lesson

Separate exhausted direct-provider routes from independent fallback defects before attributing a multi-provider gate failure.
