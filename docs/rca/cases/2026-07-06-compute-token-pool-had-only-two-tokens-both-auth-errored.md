---
id: 2026-07-06-compute-token-pool-had-only-two-tokens-both-auth-errored
date: 2026-07-06
title: The shared compute-token pool held only two claude_code tokens, both auth_error'd, so agents kept falling to the paid waterfall
surface: back-end
component: compute-credentials
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: prod Integration rows — only 2 claude_code tokens have poolingEnabled=true and both carry failureReason=auth_error
symptoms:
  - "GET /api/integrations/compute-code/credentials/token returns 404 NO_TOKENS_AVAILABLE"
  - costs skyrocketing / "compute tokens not being used"
  - agents fall through to the paid OpenRouter waterfall despite healthy code
tags:
  - compute-token
  - claude-auth
  - rate-limit
  - cost
  - token-pool
sources:
  - memory:project_compute_token_tables_missing_prod
  - agent 8e0c9c2e-1e95-4135-8dd4-43469b961c4f
repro: none-recorded
status: open
---

## Problem

After the missing compute-token tables were migrated into prod and the endpoint
stopped 500ing, costs were still elevated: the compute-token endpoint returned
404 `NO_TOKENS_AVAILABLE` for the test user, so the root agent and every
sub-agent continued to fall through to the paid OpenRouter waterfall. Diagnosed
from agent tree `8e0c9c2e-1e95-4135-8dd4-43469b961c4f` on 2026-07-06 after the
user reported costs skyrocketing.

## Diagnosis

A token-**supply** problem, entirely independent of the (by then fixed) table
crash. Prod state at the time:

- Only **2** `claude_code` integrations had `poolingEnabled=true`, and **both**
  carried `failureReason=auth_error` with `rateLimitedUntil` Jul 9-10.
  `auth_error` means bad OAuth — it needs re-auth, not merely waiting out a
  window.
- The 19 other `CONNECTED` claude tokens were user-owned with
  `poolingEnabled=false`, so they were not eligible for the pool.
- The user's own `claude_code` was rate-limited until Jul 10 and `gpt_code` was
  expired.

So the pool could never satisfy a lease, `NO_TOKENS_AVAILABLE` was the honest
answer, and the waterfall was the honest consequence. The deeper issue is that a
pool of size 2 with no health/replenishment signal degrades to zero silently and
the only symptom is a cost curve.

## Solution

The recorded next step was to replenish/repair the pool: re-auth the two
`auth_error` pool tokens or add fresh `poolingEnabled` tokens. No code fix — the
capacity math (`CLAUDE=12` / `GPT=16` concurrent leases per pool token) means
supply, not concurrency, was the binding constraint. Left open in the record.

## Human feedback

The user's lineage-lease design was clarified during this RCA: **one agent = one
lease** — one explore agent, one browser agent, one main agent each take their
own lease, so `compute_token_lineage_key = f"agent:{agent_id}"` keyed on the
agent's own id is correct. The initial reading of the `agentId`/`rootAgentId`
lease columns as implying per-tree lease sharing was wrong and was corrected.

## Reusable lesson

When compute-token cost spikes persist after the code path is proven healthy,
query the pool itself — count `poolingEnabled` tokens and read their
`failureReason`, because `auth_error` tokens never recover by waiting.
