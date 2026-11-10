---
id: 2026-11-07-staged-cycle-goes-stale-when-daemon-rotates-github-token
date: 2026-11-07
title: Staged deploy cycle goes stale mid-run because the runtime-config digest includes the daemon-rotated GITHUB_TOKEN
surface: infra
component: scripts/deploy_test_cycle.py
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: input_fingerprints hashed the raw bytes of back-end/.env and agents/.env, whose GITHUB_TOKEN line the devbox daemon rewrites whenever it refreshes the short-lived ghu_ credential
symptoms:
  - "phase: stale with zero recorded failures after every gate finished"
  - "source same: True, fingerprints equal to init: False"
  - agents/.env and back-end/.env mtime changes during a running cycle with only the GITHUB_TOKEN key differing
  - three consecutive full staged cycles discarded on PR #1721
tags:
  - deploy
  - staged-deploy-cycle
  - stale
  - github-token
  - managed-env
sources:
  - PR #1721
repro: scripts/tests/deploy-test-cycle.test.py
status: fixed
---

## Problem

Gate: NOT_INTRODUCED by the PR's source. On PR #1721 three full staged cycles
(23:35Z, 04:09Z, 05:07Z) were discarded: the coordinator finished its gates and
recorded `phase: stale` with no failures, and a stale phase credits nothing
(`full_pass_binding` returns None for a stale attempt), so a rerun of every gate
including a 40-minute cloud smoke was the only exit. The last cycle went stale 110 seconds
after init.

## Diagnosis

`input_fingerprints` binds `.env`, `back-end/.env`, `agents/.env` and the other
runtime config files by the sha256 of their bytes. The files' `GITHUB_TOKEN` is a
GitHub App user token (`ghu_`, about one hour of life; the API's
`github-authentication-token-expiration` header read 06:12:47Z for a file written
05:09:38Z) that the devbox daemon rewrites on refresh. Rewrites landed at 23:26:16Z,
04:27:07Z, 05:09:38Z and 05:12:23Z; in each case only the `GITHUB_TOKEN` key differed
from the worker copies (checked by key name, no values read). Source and
environment digests matched, so the fingerprint was the sole cause. Any staged cycle
longer than the refresh interval was therefore at risk, and a cycle needs 80+ minutes.

## Solution

`runtime_config_sha256` replaces the value of a `GITHUB_TOKEN` line with a fixed
placeholder before hashing; the key's presence, every other byte and every other
setting stay bound. `input_fingerprints` and the local-rebind config comparison both
use it. Regression: `Cycle.test_rotating_github_token_value_does_not_stale_runtime_config_but_other_changes_do`
(fails on the old code, passes 5/5; a changed setting, a removed key, an extra key and
a look-alike key still change the digest). The full `deploy-test-cycle` suite passes
(154 tests). No runtime behavior, no per-agent cost.

## Human feedback

None recorded.

## Reusable lesson

Never bind a freshness digest to a credential the platform rotates on its own schedule; bind its presence and everything else, not its value.
