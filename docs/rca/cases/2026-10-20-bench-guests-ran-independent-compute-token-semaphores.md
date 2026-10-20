---
id: 2026-10-20-bench-guests-ran-independent-compute-token-semaphores
date: 2026-10-20
title: Cloud benchmark guests each ran their own compute-token semaphore and cooldown on one real token
surface: infra
component: compute-token-lease
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/providers/computeCredentials.ts tryAcquireLineageLease / fetchComputeTokenForUser read and wrote lease + rateLimitedUntil state in each guest's own loopback Postgres, which the guest overlay had seeded with copies of the same production credential rows
symptoms:
  - "Serving compute token lease type=gpt source=user tokenIdentity=1f85ff25-6e29-4c1b-8739-f917bd101a30 liveLeaseCount=1 capacity=16"
  - "rose.transport.codex.error status=429 error_body_len=32"
  - "[GptCredentials] GPT user token for 1f85ff25-6e29-4c1b-8739-f917bd101a30 rate-limited until"
  - "Funded GPT API key backed off reason=RosePaymentRequiredError"
  - "34 GPT compute tokens rate-limited"
tags:
  - benchmark
  - cloudbench
  - compute-token
  - lease
  - rate-limit
  - isolation
sources:
  - fleet run 20261020-043809-29063
  - fleet run 20261020-043620-26484
repro: back-end/src/tests/blackbox/compute-token-authority.blackbox.ts
status: open
---

## Problem

A 60-guest Polar fleet started at 04:44Z. Every guest backend granted its own
GPT lineage lease on Andy's single ChatGPT/Codex OAuth token: 58 grants of
`liveLeaseCount=1 capacity=16` inside minute 04:44, all for
`tokenIdentity=1f85ff25-6e29-4c1b-8739-f917bd101a30` (61 grants total, every one
`liveLeaseCount=1`). OpenAI returned 285 `rose.transport.codex.error status=429`
across 56 guests between 04:44:43 and 04:45:12. Sixteen guests then
independently marked the same token rate-limited (23 `rate-limited until`
lines, 12 `already backed off` lines), and all 58 guests independently
rediscovered the out-of-credits funded GPT key (139
`Funded GPT API key backed off`). Production has one database, so it would have
refused leases 17+ and every caller would have seen the first cooldown mark.

## Diagnosis

1. Each cloud guest runs its own system Postgres on `localhost:5432/victoria`
   (`scripts/cloudbench-entrypoint.sh:139-173`) and the backend's Prisma client
   binds to it (`agents/benchmarks/run_benchmark.py:_local_victoria_database_url`).
2. `_sync_compute_tokens` (`run_benchmark.py:8022`) runs
   `seed-local.ts --compute-tokens-only`, copying the same production
   `claude_code`/`gpt_code` integration rows into every guest DB.
3. The lineage semaphore (`computeTokenLineageLease` count under
   `pg_advisory_xact_lock`, `GPT_LINEAGE_CAPACITY = 16`) and the cooldown
   (`Integration.rateLimitedUntil`) both live in that DB
   (`back-end/src/providers/computeCredentials.ts:54-58, 251-325, 422-522`).
   N guests therefore ran N independent semaphores and cooldowns on one token.
4. Why possible (Step 5a): the overlay duplicates a credential without
   duplicating, or sharing, the authority over its usage state. The same gap
   covers every `/api/integrations/compute-code/*` state (leases, OAuth
   cooldowns, funded-key, Cerebras and Anthropic-key cooldowns), which is why
   the funded-key backoff was also rediscovered 58 times.

Local repro (fails on the unfixed router):
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres node --import tsx src/tests/blackbox/compute-token-authority.blackbox.ts`
-> `AssertionError: two guests sharing one token granted 18 of 18 lineages; the shared capacity is 16 (authority holds 0 leases)`.

Archive searches: "GPT user token rate-limited isolated benchmark DB compute
token lease capacity guests", "fleet guests independent semaphore shared token
429 codex", "foundry cooldown in-stream rate limit retry-after". Relative of
2026-04-17-rate-limited-claude-token-never-marked-in-db (rotation state must
live where selection reads it); otherwise novel.

## Solution

`routes.compute.ts` gains an optional compute-token authority: when
`COMPUTE_TOKEN_AUTHORITY_URL` (+ `COMPUTE_TOKEN_AUTHORITY_API_KEY`) is set,
internal `/compute-code/*` requests are answered by that backend instead of the
local DB. Unset (production) it is a no-op. The regression starts three real
compute routers on three separate databases holding the same token row and
asserts, through two guests, that capacity 16 holds across both and that a
rate-limit mark via guest A stops guest B. Pre-fix 18/18 granted; post-fix
16/18 granted and guest B returns 404 after the mark (5 consecutive passes).

Activation (A1, approved by Andy on 2026-10-20 as the default for every
benchmark): cloud guests (fresh and pooled Machines, `scripts/run-bench-cloud`
-> `scripts/cloudbench-run.sh`) and local isolated stacks
(`agents/benchmarks/local.py`, `scripts/run-bench --local`) set
`COMPUTE_TOKEN_AUTHORITY_URL=https://navi-j9a9.onrender.com` and reuse their
own `BACKEND_API_KEY`. `BENCHMARK_COMPUTE_TOKEN_AUTHORITY=off` is the
diagnostics opt-out. A guest or local stack without the key refuses to start;
an unreachable authority fails the delegated calls closed. Covered by
`scripts/tests/cloudbench-env.test.sh` and the `benchmark` agents blackbox
(`local_isolated_compute_token_authority`). Outcome proof (a cloud fleet rerun)
is still pending, so the case stays open.

Golden references: hermes-agent keeps credential exhaustion in one auth store
under a cross-process lock (`hermes_cli/auth.py:724-736`,
`agent/credential_pool.py:134-140`); openclaw updates auth-profile cooldowns
under a store lock (`src/agents/auth-profiles/oauth-store.ts:9`,
`usage-failure-state.ts:18-27`). Both keep one shared state per credential;
this fix converges on that.

10k-agent behavior: no new DB pools; each delegated request is one HTTPS call
to the authority, the same call count a production worker already makes.
Residual: in-process backend consumers on a guest (chat compute rotation, SMS
supervisor, Codex E2B sessions) still read the local DB.

## Human feedback

None recorded.

## Reusable lesson

When an isolated environment copies a shared credential, route the credential's lease and cooldown state to one shared authority instead of copying that state too.
