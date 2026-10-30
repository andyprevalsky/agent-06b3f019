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
  - "i thought we share tokens across bench runs via attaching to prod?"
  - "COMPUTE_TOKEN_AUTHORITY_URL"
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
  - benchmark run descend-full69-20261023 proof 2 (70 cloud copies, source 7eb275b1b, campaign-qualified600-49066a4210aeb9e0a6a83e85-815)
  - commit e34d5c1f6 (backend authority on main); 31eaccdb6 (guest wiring, never merged)
repro: back-end/src/tests/blackbox/compute-token-authority.blackbox.ts; scripts/tests/cloudbench-env.test.sh (guest activation)
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

## Recurrence 2026-10-23 (descend-full69 proof 2)

Why the earlier fix did not hold: only the backend half landed on main
(`e34d5c1f6`, Oct 21: routes.compute.ts delegation + computeTokenAuthority.ts).
The guest activation (`31eaccdb6`, cloudbench-run.sh STACK_ENV + local.py
defaults) stayed on the unmerged `fix/polar-*` branches, and this case file never
reached main either (the code comment cites a case that was missing from the
archive). Nothing sets `COMPUTE_TOKEN_AUTHORITY_URL` on a guest: not the staged
back-end/.env, the bench app secrets, the boxes managed env or cloudbench-run.sh.

Evidence: 0 `Delegated compute-token request` lines across 70 guests; 81
`Serving compute token lease ... capacity=16` grants (77 with liveLeaseCount=1,
4 with 2) on token identity 1f85ff25 in one start-up minute. There were 201
`rose.transport.codex.error status=429` on 72 of 1481 Rose calls in 57 of 70
copies, all between 23:16 and 23:17Z. Each affected call spent 3 codex attempts
5s apart, then went OpenAI key (402) -> Anthropic key (400) -> Foundry. Start to
first chunk: p50 13.3s, p90 14.9s, max 34.6s, versus p50 2.35s for 450 healthy
codex calls. Added time per copy: p50 13.6s, max 51.2s. All 72 calls recovered
(52 served by Foundry, 20 by codex on retry), and no verdict is attributable.
`rose-1-ultra` throughout. Production read-only probe: the guest
BACKEND_API_KEY is production's, and `runReadOnlyProductionAuthority` with the
authority set to prod returned `row-envelope-and-remainingSeconds`.

Activation fix (approval-gated, since it writes bench leases and cooldowns to
production): `cloudbench_apply_compute_token_authority` in
scripts/lib/cloudbench-env.sh appends `COMPUTE_TOKEN_AUTHORITY_URL`
(default https://navi-j9a9.onrender.com, `CLOUDBENCH_COMPUTE_TOKEN_AUTHORITY_URL=off`
opts out) and `COMPUTE_TOKEN_AUTHORITY_API_KEY` (the guest's BACKEND_API_KEY)
to the decoded guest back-end/.env. cloudbench-run.sh calls it right after the
digest checks. Regression in scripts/tests/cloudbench-env.test.sh: it failed
before the fix (`FAIL: a guest backend env with BACKEND_API_KEY must gain the
compute-token authority`) and passes after (full suite rc=0, 5 consecutive
runs). Residual gaps: `--local` isolated stacks are not wired, and in-process
guest consumers (chat rotation, SMS supervisor) still read the local DB.

## Human feedback

2026-10-24 (Andy): "i thought we share tokens across bench runs via attaching to prod?". He expected guests to use the production authority. Also 2026-10-24: the out-of-credit funded keys (402) are fine; make no change for them.

## Reusable lesson

When an isolated environment copies a shared credential, route the credential's lease and cooldown state to one shared authority instead of copying that state too.


### 2026-10-21 environment precedence correction

The completion lane changed local authority-key derivation to honor the explicit
injected authority key first, then injected BACKEND_API_KEY, then back-end/.env.
The existing local-start regression fails against the previous helper and passes
with the corrected precedence. The explicit diagnostic opt-out still clears both
authority exports. No production setting was written or deployed.
