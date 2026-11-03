---
id: 2026-10-15-backend-codex-fixture-path-leaked-into-agents-gate
date: 2026-10-15
title: Backend credential fixture path escaped into unrelated agents coverage
surface: agents
component: benchmark-compute-token-fixtures
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The deployment shell exported backend-only CODEX_AUTH_PATH to agents coverage, activating explicit-auth routing inside generic source-database mocks
symptoms:
  - Explicit Codex auth requires an isolated loopback database
  - Benchmark sync could not refresh GPT credentials from explicit Codex auth
  - compute_token_source_ignores_isolated_process_target
  - compute_token_preflight_isolated_source
tags:
  - coverage
  - credential-fixture
  - environment-scope
sources:
  - commit b5475e5be1f98e48e709298c0afcd2ea2e550ce7
  - plan:.context/legacy-control-repair/benchmark-env-before.log
  - plan:.context/legacy-control-repair/benchmark-env-after.log
repro: agents/tests/blackbox/benchmark.blackbox.py::test_compute_token_sync_reads_source_file_not_isolated_process_target
status: mitigated
---

## Problem

Fresh agents coverage on exact b547 returned107/110 domains, including five failed compute-token source fixtures in benchmark. The backend supported live Codex smoke needed a current local auth path, a dedicated fixture identity and an isolated loopback DB. The deployment shell unnecessarily exported that backend-only path into every lane. The generic agents fixtures intentionally substitute source/target DSNs and seed subprocesses; an explicit credential path selects a different strict local-auth contract.

## Diagnosis

The first bad boundary was invocation scope, not missing or revoked credentials. The exact five existing registered functions fail5/5 with the ambient CODEX_AUTH_PATH; all five pass with ONLY that variable removed. Every assertion and production function remains unchanged. The actual replay intercepts HTTP transports, sockets and child-process boundaries and asserts zero attempted external operations, including swallowed attempts. Before elapsed0.060s; after0.079s. This is not a model or provider failure and is unrelated to the three retained native auth-choice failures.

Two archive searches used "Explicit Codex auth isolated loopback database" and "backend fixture environment leaked benchmark compute token". The October14 current-account fixture case and September27 explicit-authority case are relatives: they establish why the backend fixture needs an authoritative path, not evidence that those credential-selection incidents recurred here. No credential ownership or provider revocation fix is claimed.

## Solution

Move only CODEX_AUTH_PATH from the common deployment lane environment to the backend-specific invocation environment. Preserve the same backend fixture user, private auth path, pooling setting and owned loopback DB. Agents source-DSN controls use their normal environment and assertions. No runtime, test assertion, provider validation, database isolation rule or timeout is weakened. Existing permanently registered benchmark controls expose this invocation mismatch; no duplicate implementation-mirroring test is added. The canonical full agents gate must rerun after the separate accepted test-only corrections; this case remains mitigated pending that gate, not deployment-complete.

## Human feedback

The coordinating parent required the exact five controls to fail/pass with only invocation scope corrected, preserving the supported backend fixture and owned loopback DB. No actual user credential or production environment change was requested or performed. The original full coverage failure remains retained.

## Reusable lesson

Scope explicit credential fixture inputs to the gate that owns that credential authority instead of exporting them to unrelated test lanes.
