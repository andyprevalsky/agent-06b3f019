---
id: 2026-11-07-cloudbench-token-resolver-had-no-candidate-outside-the-drained-user-identity
date: 2026-11-07
title: Cloudbench GitHub token resolvers had no candidate outside Andy's user identity, so a drained quota left guests without a working credential
surface: infra
component: cloudbench-github-token
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud resolve_github_token and scripts/lib/cloudbench-github-token.sh cloudbench_resolve_github_token only tried tokens that all belong to user 25310436 (GITHUB_TOKEN, GITHUB_DISPATCH_TOKEN, gh, git credential), never the org GitHub App
symptoms:
  - "FAIL: resolve_github_token returned empty despite available controller credentials"
  - "[cloudbench] FATAL: could not fetch requested ref"
  - "fatal: could not read Username for 'https://github.com': No such device or address"
  - "API rate limit exceeded for user ID 25310436"
tags:
  - cloudbench
  - github
  - token-pool
  - rate-limit
sources:
  - PR #1723 deploy, cloudbench-controller gate on aa01493d1 (06:xx) and smoke gate on 2449803fd (16:23)
  - task .context/deploy-cloud/a29f0128cb1da0243b0a5a6df7f09b05888b6e9bf2f22840a6550105fb8437e1/cli.log
repro: bash scripts/tests/cloudbench-github-token.test.sh
status: mitigated
---

## Problem

Gate: NOT_INTRODUCED (the resolvers are unchanged by PR #1723, which adds the GitHub App to the backend pool and
`scripts/github_token_pool.py`). Twice during this deploy, cloud benchmark work lost GitHub access exactly while Andy's
`GITHUB_TOKEN` (user 25310436) reported `core=0/5000`. The cloudbench-controller gate's live resolver check failed with
`resolve_github_token returned empty despite available controller credentials`. Later, all nine smoke guests failed
`could not fetch requested ref 2449803fd...`, with `could not read Username` (GitHub rejected the header). Once the
user quota reset, every candidate passed `git ls-remote` again from the same host.

## Diagnosis

Both resolvers build candidates only from sources that resolve to the same user identity: `GITHUB_TOKEN`,
`GITHUB_DISPATCH_TOKEN`, `gh auth token`, and the devbox git credential helper (itself rate limited:
"boxes-github-credential: GitHub's API rate limit was reached"). When that one identity is drained there is no other
member to fall back to, even though the org GitHub App (installation 179159574) had 5000/5000 left.

The regression reproduces the boundary: with every user-token candidate unusable and a pool that can supply a working
token, the unchanged resolver returns nothing (`FAIL: resolver ignored the token pool when every user-token candidate
was unusable`). Observability gap: the exact GitHub response that rejected the guest fetch was not captured, so the
claim that git-over-HTTPS rejects a quota-drained token is inferred from the two timed coincidences, not observed.

Archive search found relatives, not a recurrence: `2026-08-19-refresh-deps-invalid-env-github-token` (an injected
invalid token) and `2026-08-19-refresh-deps-empty-github-token-aborts-fleet` (an empty box token).

## Solution

Both resolvers now try the token pool's `scripts/github_token_pool.py pick` as their last candidate and validate it
with the same contents check. `pick` ranks every member by remaining quota and includes the App's hourly installation
token. It is used only for the ephemeral controller-to-guest sync; `resolve_durable_github_token` (Fly app secrets)
is unchanged, so a one-hour token never becomes a durable secret. `scripts/tests/cloudbench-github-token.test.sh`
gains a case that fails without the fallback, passes with it, and still fails closed when the pool pick cannot read the
repo, plus a static check that `run-bench-cloud` keeps the fallback.

10k agents: one extra local subprocess only after every existing candidate fails; nothing per agent.

## Human feedback

None recorded.

## Reusable lesson

A credential fallback chain must include at least one member with independent quota; tokens that resolve to one user
share one rate limit and fail together.
