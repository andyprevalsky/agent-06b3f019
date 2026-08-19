---
id: 2026-08-19-refresh-deps-invalid-env-github-token
date: 2026-08-19
title: Fleet --refresh-deps used injected invalid GITHUB_TOKEN so fetch-ref 401ed as a username prompt
surface: infra
component: cloudbench-refresh-deps
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud warm_source_fetch_ref token="$(gh auth token || resolve_github_token)" — gh returns injected invalid $GITHUB_TOKEN
symptoms:
  - "The token in GITHUB_TOKEN is invalid"
  - "fatal: could not read Username for 'https://github.com': No such device or address"
  - "FATAL: could not fetch requested ref"
  - "exact remote checkout failed"
  - "central dep refresh failed; refusing to provision task machines"
tags:
  - cloudbench
  - refresh-deps
  - github-token
  - fetch-ref
  - fleet
sources:
  - PR #1001
  - commit 229a63bac616cf7860ac796e31bafa28c4fef9c0
repro: scripts/tests/cloudbench-env.test.sh
status: fixed
---

## Problem

Epoch 4 fleet `20260819-191421-61077` uploaded `cloudbench-fetch-ref.sh`
(5789 bytes) then failed:

`fatal: could not read Username for 'https://github.com': No such device or address`
`[cloudbench] FATAL: could not fetch requested ref f9ad6715cc0d572a5ad54c3dbedae73bf5c5ee00`
`central dep refresh failed; refusing to provision task machines`

No task machine started. I-01's fetch-ref upload path ran; the token it
injected was rejected.

## Diagnosis

`gh auth status` reported `The token in GITHUB_TOKEN is invalid` while a
working Cursor `ghs_` credential existed in `~/.config/gh/hosts.yml` and
in git `url.*.insteadOf`. `gh auth token` and `.env` `GITHUB_TOKEN` both
returned the same 93-byte `github_pat_` (injected env overrides `.env`).

Local owning-boundary repro (no token printed):

- `GITHUB_TOKEN` / `gh auth token` extraheader `git ls-remote` → rc=128,
  `Authentication failed` / `could not read Username`
- `env -u GITHUB_TOKEN gh auth token` → 390-byte `ghs_`; extraheader
  `ls-remote` → rc=0, 46-byte stdout
- I-01's structural test only required that *a* token was injected, so the
  invalid env token passed the guardrail

Archive searches (`could not fetch requested ref`, `GITHUB_TOKEN is invalid`,
`refresh-deps username`) hit I-01 as a relative. Recurrence of the token
boundary: the previous fix held the helper and still selected the wrong
credential.

## Solution

`cloudbench_controller_github_token` in `scripts/lib/cloudbench-env.sh`
resolves `env -u GITHUB_TOKEN gh auth token`, then git `url.insteadOf`.
`--refresh-deps`, boot-launch, and fleet worker token cache use it. They
never prefer injected `$GITHUB_TOKEN`.

Cemented by `scripts/tests/cloudbench-env.test.sh`: with
`GITHUB_TOKEN=github_pat_INVALID` the helper must not return that value,
and the insteadOf fallback parses `ghs_INSTEADOF` when `gh` exits 1.

Unchanged post-fix probe: helper + extraheader `ls-remote` rc=0, 46-byte
stdout, resolver_len=390.

## Human feedback

None recorded.

## Reusable lesson

A present GitHub token is not a working GitHub token. Ignore injected
`$GITHUB_TOKEN` when resolving controller git credentials; use the
hosts.yml / insteadOf credential that already pushes this workspace.
