---
id: 2026-11-07-blacksmith-semantic-gate-shares-one-reserved-ngrok-domain
date: 2026-11-07
title: semantic-stack failed on a Blacksmith VM because another deploy's gate held the shared reserved ngrok domain and the Cloudflare fallback never routed
surface: harness
component: deploy-semantic-stack
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: every Blacksmith runner checks the repository out into a directory named `rose`, so run.sh derives the same reserved tunnel domain rose-rose.ngrok.app for every concurrent deploy's semantic-stack gate; when ngrok answers ERR_NGROK_334 the fallback (Cloudflare quick tunnels) did not become routable from the VM
symptoms:
  - "ERR_NGROK_334 The endpoint 'https://rose-rose.ngrok.app' is already online"
  - "never routed within 45s; recycling the quick tunnel (attempts 1/3 to 3/3)"
  - "No public tunnel provider could serve :12001 (reserved ngrok domain held elsewhere; tried cloudflare)"
  - "Step5 stack exited before readiness (see .context/deploy-smoke.log)"
tags:
  - semantic-stack
  - blacksmith
  - ngrok
  - concurrent-deploys
  - tunnel
sources:
  - PR #1747 deploy round 4 (source 02eb65acf1), gate semantic-stack, GitHub Actions run of 2026-11-07 18:46Z; passed in rounds 2, 3 and 5
  - PR #1760 deploy, gate semantic-stack deploy-gates/8vcpu/semantic-stack-4d7e6b834333cd6b (source ddfe9f2881ce, started 17:12:34Z) while integrate/rose-on-rose's semantic-stack-1fa519051616dc85 (17:07:14Z) held rose-rose.ngrok.app
repro: from a checkout named semrepro, hold rose-semrepro.ngrok.app with a second `ngrok http 9 --domain rose-semrepro.ngrok.app` agent and put a failing `cloudflared` shim first on PATH (the VM's unroutable quick tunnels), then run `CONDUCTOR_PORT=23000 CONDUCTOR_WORKSPACE_NAME=deploy-semantic-stack ROSE_USE_SYSTEM_PG=true bash scripts/run-deploy-semantic-stack.sh`; regression `bash scripts/tests/run-deploy-semantic-stack.test.sh` (deploy structural gate deploy-semantic-stack)
status: fixed
---

## Problem

The gate was UNVERIFIED with its stack dead before readiness. Other deploys were running Deploy gate jobs at the same time (GitHub Actions listed three), and the ngrok API showed `rose-rose.ngrok.app` online from a session that started after this gate began.

## Diagnosis

Gate: NOT_INTRODUCED (no tunnel code changed). `scripts/run.sh` binds `rose-<workspace>.ngrok.app`; on the runner the workspace is the checkout name `rose` ("CONDUCTOR_WORKSPACE_NAME=deploy-semantic-stack does not match workspace path ...; using rose"), identical for every deploy. The documented ERR_NGROK_334 fallback is an account-less Cloudflare quick tunnel; on the Blacksmith VM its edge verification failed three times, so no provider served the frontend. The same gate passed in three other rounds when the domain was free.

## Solution

The semantic stack no longer opens a public tunnel: `scripts/run-deploy-semantic-stack.sh` launches `run.sh --benchmark` with the existing `BENCHMARK_SKIP_PUBLIC_TUNNEL=1` opt-out, so `PUBLIC_BASE_URL` is the local frontend and no ngrok or Cloudflare endpoint is requested. No spec under `front-end/tests-e2e` reaches the stack through a public origin (the browser take-control and chip specs seed their live-view URLs; the only backend `PUBLIC_BASE_URL` reader is the Vapi/Twilio hold webhook, which no semantic spec drives), so the suite, its assertions and timeouts are unchanged. Concurrent deploys' gate VMs therefore share nothing tunnel-scoped. The fix was first written on feat/gate-early-failure (2c36501e57) and cherry-picked unchanged.

Local repro (2026-11-08, scratch checkout `semrepro` at cdb8ce580, domain held by a second agent, cloudflared failing): `ERR_NGROK_334 ... 'https://rose-semrepro.ngrok.app' is already online`, three quick-tunnel attempts, `No public tunnel provider could serve :23001 (reserved ngrok domain held elsewhere; tried cloudflare)`, `Step5 stack exited before readiness`, exit 1. The same command on the fix under the same conditions reached readiness and ran the semantic suite. The regression fails on the old script (`the semantic stack must not contend for a shared public tunnel`).

10k-agent behavior: not agent-scaled; one fewer shared account-wide resource per deploy gate.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A resource keyed by the checkout directory name is global once the directory name is the same on every CI machine.
