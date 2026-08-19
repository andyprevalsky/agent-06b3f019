---
id: 2026-08-12-local-smoke-hub-defaults-to-dead-prod
date: 2026-08-12
title: Local smoke fail-closed Hub registration defaulted to prod, so a prod 502 deadlocked /deploy of the outage fix
surface: harness
component: benchmark-hub-upload
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/benchmarks/run_benchmark.py — os.environ.setdefault(BENCHMARK_HUB_UPLOAD_URL, DEFAULT_HUB_URL) before require_run_visible"
symptoms:
  - "benchmark Hub visibility check failed: HTTP Error 502: Bad Gateway"
  - "HubVisibilityError: benchmark Hub visibility check failed"
  - "uploaded run bundle to hub:" followed by urllib HTTPError 502 against navi-j9a9.onrender.com
  - "scripts/run-predeploy-local exits 1 before any smoke task runs when prod /health is 502"
tags:
  - benchmarks
  - hub
  - deploy
  - smoke
  - deadlock
sources:
  - agent bc-019ff52c-1af4-7932-b397-677856e94aac
  - PR #972
repro: agents/benchmarks/hub_upload_test.py::test_resolve_hub_upload_url_uses_local_stack_when_unset
status: fixed
---

## Problem

During `/deploy` of the IndexedDB-upload OOM fix, local Pre-Deploy smoke
(`scripts/run-predeploy-local`) failed before any task ran:

```
📤 uploaded run bundle to hub: <run_id>
HubVisibilityError: benchmark Hub visibility check failed: HTTP Error 502: Bad Gateway
```

`https://navi-j9a9.onrender.com/health` was itself 502 from the OOM crash-loop
the PR was shipping to fix. Local smoke therefore could not prove the fix.

## Diagnosis

`run_benchmark.py` always `setdefault`s `BENCHMARK_HUB_UPLOAD_URL` to
`DEFAULT_HUB_URL` (prod Render) before `require_run_visible`, even when
`base_url` is the isolated local stack (`http://localhost:<port>`). Upload
succeeded enough to print a run id (or raced a brief healthy window), then the
GET visibility check hit the crash-looping prod backend and raised.

Archive search (`Hub visibility 502`, `require_run_visible`) found relatives
about hub ports and poller `set -e` outages, but not this localhost→prod
deadlock. Novel harness contract bug exposed by the IndexedDB OOM outage.

## Solution

`resolve_hub_upload_url(base_url)` in `hub_upload.py`: explicit env wins; for
unset + localhost/127.0.0.1 base_url, register against the stack under test;
otherwise keep the prod default. `run_benchmark.py` uses that helper instead of
hard-defaulting to prod. Cemented in `hub_upload_test.py`.

10k-agent behavior: per-run registration still one POST+GET against a single
Hub URL; local runs no longer fan into a shared dying prod instance. No new
shared fan-in.

## Human feedback

None recorded.

## Reusable lesson

Never make a local fail-closed gate depend on production reachability — register
local smoke against the local stack under test so a prod outage cannot deadlock
shipping its own fix.
