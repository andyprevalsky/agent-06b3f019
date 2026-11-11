---
id: 2026-11-11-semantic-stack-disabled-remote-code-agent-callbacks
date: 2026-11-11
title: Semantic stack disabled the public origin needed by remote code agents
surface: harness
component: deploy-semantic-stack
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: semantic launcher forces public tunnel off before minting sandbox tool URLs
symptoms:
  - code-agent callbackOrigin is http://localhost:12000
  - real-agent semantic attempts time out before completing their message assertions
tags:
  - deploy
  - semantic
  - callback
  - isolation
sources:
  - PR #1915
  - plan: .context/rca-playwright/semantic-callback-origin/findings.json
  - plan: .context/rca-playwright/semantic-observation-4092/analysis/findings.json
repro: scripts/tests/run-deploy-semantic-stack.test.sh
status: fixed
---

## Problem

The semantic launcher disabled its public tunnel because the browser tests reach
the local frontend directly. That avoided collisions between gate VMs sharing a
reserved workspace domain, but the suite also creates real remote code agents.
Their tool URL producer therefore received the local backend origin.

Current source-bound diagnostics recorded constructed callback origin
http://localhost:12000 for four sessions and retained callback fetch failures in
three. Both mobile attempts failed their message predicate. Realtime failed the
predicate once and reached it before timing out during the duplicate-check grace
once. These are distinct native outcomes, retained unchanged.

## Diagnosis

The launcher forces BENCHMARK_SKIP_PUBLIC_TUNNEL=1. The actual run.sh flow then
sets a local public URL; export_sandbox_backend_base_url only supplies a sandbox
override for HTTPS. The unchanged withAgentTools producer falls back to the
local BACKEND_URL. The registered shell fixture executes that launch environment,
the real tunnel/export helpers and actual backend producer: the original source
emits a loopback callback and fails the HTTPS assertion.

This proves the configuration defect. It does not prove every sandbox's consumed
tools file, network listener state or full timed UI cause. The original native
failures and UNKNOWN attributions remain open until actual source-bound acceptance.

## Solution

Enable the existing ephemeral tunnel flow for this lane. Give its endpoint a
hashed per-run identity from the native token, with a UUID for direct invocation.
Preserve workspace, database, ports, queue and local frontend identity. Do not
create permanent per-run reservations or fall back to the shared workspace
endpoint. Validate the provider-reported origin and upstream, require the owned
tunnel process and reap that process on failure through existing cleanup.

Explicitly keep the existing direct model transport with
DISABLE_FAST_MODE_PROXY=1; the public callback must not switch Claude calls to a
proxy. Codex proxy behavior, prompts, completion policy, assertions, deadlines,
retries and concurrency remain unchanged.

The same registered fixture was observed RED before the source fix. The fixture
uses an explicit repository TypeScript loader so a real temporary directory does
not accidentally depend on ancestor node_modules. Endpoint metadata is synthetic;
no favorable callback or model response is substituted. Genuine provider routing
and full timed UI acceptance remain required.

## Human feedback

The user requires the assigned SDK repair through deployment while retaining
actual failed tests, avoiding duplicate repairs and preserving financial limits.
The existing diagnostic owner confirmed no competing callback correction. This
configuration correction grants no production SDK acceptance or test waiver.

## Reusable lesson

Local test navigation does not make every participant local. Preserve a
run-owned public callback for remote actors without changing the local stack's
identity or its behavioral contracts.
