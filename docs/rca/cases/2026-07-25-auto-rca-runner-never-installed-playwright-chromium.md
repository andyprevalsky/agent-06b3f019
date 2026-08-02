---
id: 2026-07-25-auto-rca-runner-never-installed-playwright-chromium
date: 2026-07-25
title: Auto-RCA GitHub runner ran the offline deploy gate without ever installing Playwright Chromium
surface: harness
component: auto-rca-workflow
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: .github/workflows/auto-rca.yml hydrate step — no `playwright install` for the agents venv
symptoms:
  - '"Executable doesn''t exist … chrome-headless-shell" in the auto-rca offline_gates step'
  - every real auto-rca run ends failure (30113998621 — 51m, $9.15, 81 turns)
  - agents blackbox fails in a bare ubuntu-latest runner but passes locally
tags:
  - auto-rca
  - github-actions
  - playwright
  - deploy-gate
  - environment-hydration
sources:
  - PR #896
  - commit cd83b5101
  - memory:project_agent_failure_alerting
repro: none-recorded
status: fixed
---

## Problem

Every real Auto-RCA run failed. Run 30113998621 burned 51 minutes, $9.15 and 81
turns before dying, and runs 30085424508, 30084498097 and 30075739188 all failed
the same way. The `offline_gates` step (`scripts/test.sh --no-smoke`) logged
`Executable doesn't exist … chrome-headless-shell`. Draft PRs were being created
(#877, #882), so the agent itself worked — only the in-runner gate was red.

## Diagnosis

The agents blackbox suite mocks HTTP but launches a **real Chromium** (agents use
Python Playwright 1.61); `auto-rca.yml`'s hydrate step never ran
`playwright install`, so a bare `ubuntu-latest` runner had no browser binary. PRs
#885–#892 kept band-aiding dependency hydration without fixing this, which
reinforced a broader (and initially correct-looking) theory that the in-runner
gate was architecturally unpassable and full-resource repro had to move to the
Fly fleet. Reading the actual gate contents disproved most of that: the
front-end semantic suite is skipped under `--no-smoke`, the "Semantic Deploy
Gate" at `scripts/test.sh:307` is a grep contract test with no browser, and
`prisma db push` already runs inside `run-blackbox-tests.sh` (line 221) against
the service Postgres — so backend blackbox _can_ run in-runner. The only genuine
gap was the missing browser binary.

## Solution

PR #896 adds `sudo agents/venv/bin/python -m playwright install-deps chromium`
plus `agents/venv/bin/python -m playwright install chromium` to the hydrate step.
Verified on real run 30170612351 (agent `aa32b7e6`): the offline deploy gate is
green on both the primary and the retry attempt. Domains run in isolated
subprocesses via `run_coverage_blackbox_parallel.py`, so the real Chromium does
not cause cross-domain capture corruption. Note that `auto-rca.yml` checks out
`ref: main` and installs `scripts/auto-rca-tool` from main, so tool-side fixes
only take effect once merged.

## Human feedback

None recorded.

## Reusable lesson

Before declaring a CI gate architecturally unrunnable, enumerate what each suite
actually launches — a missing `playwright install` looks identical to "this
environment can never run browsers".
