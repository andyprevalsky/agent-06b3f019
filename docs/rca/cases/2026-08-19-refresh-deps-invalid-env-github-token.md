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

I-04 (2026-08-19): GITHUB_TOKEN should be set correctly in the current env.
Iterate until INFRA is fixed — I-03's ignore-invalid-token path is not enough
when children still read `$GITHUB_TOKEN` / dotenv.

## Recurrence — I-04 process env still held the invalid PAT

I-03 selected the working `ghs_` token for fetch-ref only. After the
infra-clean epoch-5 fleet, this Cloud session still had:

- process `$GITHUB_TOKEN` len=93 `github_pat_`
- `agents/.env` and `back-end/.env` the same invalid PAT
- `gh auth token` echoed the injected PAT; `gh auth status` reported
  `The token in GITHUB_TOKEN is invalid`

Local owning-boundary pair (no token printed):

- RED: extraheader `ls-remote` with process `$GITHUB_TOKEN` → rc=128,
  `could not read Username` / terminal prompts disabled
- GREEN: `cloudbench_export_controller_github_token` then extraheader
  `ls-remote` → rc=0, out_len=57; process + both `.env` files len=390
  `ghs_`; `gh auth status` uses GITHUB_TOKEN as the active account

## Solution (I-04)

`cloudbench_export_controller_github_token` exports the I-03 resolver
into `$GITHUB_TOKEN` and upserts `GITHUB_TOKEN=` in listed dotenv files.
`scripts/cloud-init.sh`, `scripts/run-bench-cloud`, and
`scripts/run-bench-fleet` call it so the current env is corrected, not
only the fetch-ref header.

Cemented by `scripts/tests/cloudbench-env.test.sh`: with
`GITHUB_TOKEN=github_pat_INVALID` the export helper overwrites process
env and replaces a stale `GITHUB_TOKEN=` in dest `.env` files while
preserving other keys.

## Reusable lesson

A present GitHub token is not a working GitHub token. Ignore injected
`$GITHUB_TOKEN` when resolving controller git credentials; then **export
the working credential back into the process env and local `.env`** so
every child that still reads `$GITHUB_TOKEN` inherits it. Use the
hosts.yml / insteadOf credential that already pushes this workspace.
