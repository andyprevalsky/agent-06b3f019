---
id: 2026-11-07-blacksmith-semantic-gate-shares-one-reserved-ngrok-domain
date: 2026-11-07
title: semantic-stack failed on a Blacksmith VM because another deploy's gate held the shared reserved ngrok domain and the Cloudflare fallback never routed
surface: harness
component: deploy-semantic-stack
classification: configuration-error
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
repro: curl -H "Authorization: Bearer $NGROK_API_KEY" -H "Ngrok-Version: 2" https://api.ngrok.com/endpoints lists https://rose-rose.ngrok.app from a foreign tunnel session while the gate runs
status: open
---

## Problem

The gate was UNVERIFIED with its stack dead before readiness. Other deploys were running Deploy gate jobs at the same time (GitHub Actions listed three), and the ngrok API showed `rose-rose.ngrok.app` online from a session that started after this gate began.

## Diagnosis

Gate: NOT_INTRODUCED (no tunnel code changed). `scripts/run.sh` binds `rose-<workspace>.ngrok.app`; on the runner the workspace is the checkout name `rose` ("CONDUCTOR_WORKSPACE_NAME=deploy-semantic-stack does not match workspace path ...; using rose"), identical for every deploy. The documented ERR_NGROK_334 fallback is an account-less Cloudflare quick tunnel; on the Blacksmith VM its edge verification failed three times, so no provider served the frontend. The same gate passed in three other rounds when the domain was free.

## Solution

Not done in PR #1747; proposed fix:

Give each run its own tunnel identity (a per-run workspace label, which means a per-run reserved or ephemeral domain; check the ngrok plan limits first) or make the fallback verifiable from the runner (for example force HTTP/2 for cloudflared). Until then, check the endpoint list before launching and rerun the single gate when the domain is free.

10k-agent behavior: not agent-scaled.

Golden reference: not applicable (no approval-gated hunk).

## Human feedback

None recorded.

## Reusable lesson

A resource keyed by the checkout directory name is global once the directory name is the same on every CI machine.
