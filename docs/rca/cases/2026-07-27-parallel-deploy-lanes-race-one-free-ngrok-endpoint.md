---
id: 2026-07-27-parallel-deploy-lanes-race-one-free-ngrok-endpoint
date: 2026-07-27
title: Parallel deploy lanes raced the single free ngrok endpoint once trycloudflare was rate-limited
surface: harness
component: deploy-pipeline
classification: configuration-error
problem_class: other
first_bad_boundary: start_ngrok_ephemeral_tunnel — the free ngrok account grants exactly one static ephemeral endpoint, and both Group 4 lanes fell back to it simultaneously
symptoms:
  - "ERR_NGROK_334: The endpoint '...' is already online"
  - "run.sh exited early with code 1"
  - "local.py wait_for_services RuntimeError"
tags:
  - ngrok
  - tunnel
  - deploy-gate
  - parallel-lanes
  - shared-global-resource
sources:
  - PR #912
  - memory:project_ngrok_free_endpoint_collision
repro: none-recorded
status: mitigated
---

## Problem

During the `/deploy` of PR #912 on 2026-07-27, the AgentCard lifecycle gate died
with `ERR_NGROK_334: The endpoint '...' is already online`, which cascaded into
`run.sh exited early with code 1` and a `local.py wait_for_services`
RuntimeError. The smoke lane, running in parallel, had already claimed
`https://unadmirably-unelicitable-myung.ngrok-free.dev`.

## Diagnosis

`/deploy` launches smoke and the AgentCard lifecycle gate as parallel Group 4
lanes; each spins its own isolated stack via `run-bench --local`, and each stack
wants a public frontend tunnel. trycloudflare quick tunnels were rate-limited
that day, so both stacks exhausted `CLOUDFLARE_TUNNEL_MAX_ATTEMPTS=3` and fell
back to `start_ngrok_ephemeral_tunnel`. The ngrok account is free
(`*.ngrok-free.dev`), which grants exactly ONE static ephemeral endpoint, so the
second lane could not possibly succeed. The deeper owned cause: the two lanes are
only parallel-safe while trycloudflare is healthy — the fallback path funnels both
lanes onto a single-instance global resource with no lock and no reservation, so
provider flake in one dependency silently converts a parallel-safe design into a
mutually exclusive one.

## Solution

Immediate workaround: run the lanes serially — let smoke finish, then re-run the
AgentCard gate so it can claim the single endpoint. Real fixes in preference
order: (1) upgrade the ngrok account for multiple simultaneous endpoints, or
reserve one domain per bench run the way `run.sh` already does for the primary
worktree stack (`rose-<worktree>.ngrok.app`); (2) take a machine-wide lock around
the ngrok ephemeral fallback so a second stack waits instead of crashing;
(3) pass `BENCHMARK_SKIP_PUBLIC_TUNNEL=1` for lanes that need no public origin
(`run.sh` prints this hint), verified per-task — not safe for AgentCard payment
tasks, which need a public onboarding-callback origin. Also found: `NGROK_API_KEY`
in `back-end/.env` is stale (`ngrok api tunnels list` → `403 ERR_NGROK_203`);
harmless today because the ephemeral path uses the authtoken in
`~/Library/Application Support/ngrok/ngrok.yml`, but
`ensure_ngrok_domain_reserved` would fail on a fresh workspace.

## Human feedback

The recorded judgment rejects the fix ngrok's own error message suggests:
do NOT use `--pooling-enabled`, because it load-balances one URL across both
stacks and requests would land on the wrong benchmark's frontend at random —
worse than failing loudly.

## Reusable lesson

Before running lanes in parallel, check every fallback path for single-instance
global resources — and reject "load-balance the shared URL" style fixes that trade
a loud crash for silent cross-run traffic leakage.
