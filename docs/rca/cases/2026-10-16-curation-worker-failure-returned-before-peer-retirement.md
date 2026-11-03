---
id: 2026-10-16-curation-worker-failure-returned-before-peer-retirement
date: 2026-10-16
title: Archive curation rejected before its peer workers retired
surface: back-end
component: trace-archive-curation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: curateTraceArchives awaited fail-fast Promise.all without stopping shared-index claims or joining peers after a worker error
symptoms:
  - caller must not reject before peer joins
  - no new claims after first failure
  - no deletion after caller rejection
tags:
  - trace-archive
  - worker-pool
  - concurrency
  - error-propagation
sources:
  - PR #1453 comment 4290940149 review 5543091722
  - commit f204831d1b8bfe8197b617901f5126964ec34740
  - plan:/dev/shm/rose-whm-deploy-gates-20261015/task-private/c2-rca-curation-pool-01a136f6/result.private.json
repro: back-end/src/tests/blackbox/archive.blackbox.ts; back-end/src/tests/blackbox/archive-curation-pool.controls.ts; back-end/src/tests/unit/trace-archive-curation-pool.test.ts
status: open
---

## Problem

C2 review identified a worker-lifecycle mechanism, not a captured production deletion incident. On exact f204 source, the owning deferred-promise control made classification, deletion or synchronous onResult throw while another worker remained in classification. The caller observed rejection immediately; releasing the peer then caused claims for c and d and deletions after the caller had already received the error. No R2 or real deletion was invoked.

## Diagnosis

Promise.all rejects when one worker rejects but does not cancel siblings. Those siblings retain the shared next index and keep claiming roots. The first bad boundary is the pool owner's return, not archive classification/membership. A falsey thrown value also requires a separate failure flag rather than testing the error's truthiness. The next broader fix would replace independent archive APIs with a new scheduler; that is unnecessary because stopping admission and retaining ownership through settlement resolves this lifecycle class at its existing owner.

Two archive searches used literal Promise.all/curateTraceArchives/deletion vocabulary and worker/in-flight/peer continuation vocabulary. The prior curation API nonfinite-count case is a relative: its boundary is admission validation, whereas this case is failure retirement. The disconnected-delete and worker-fixture ownership cases reinforce the ownership lesson but are not recurrences or evidence of this mechanism.

Golden references: back-end/src/providers/traceArchiveLifecycle.ts:62 joins all storage workers with Promise.allSettled before propagating an error; claude-code-src/src/utils/task/diskOutput.ts:245-252 cancels pending writes then joins tracked operations before clearing ownership. This repair converges on joining owned work; its shared flag additionally stops new curation claims. openclaw, hermes-agent and codex reference trees were absent at the checkout paths; no network sync was authorized or performed.

## Solution

Each worker catches its failure, the first catch seals new claims and retains the exact error, all admitted workers settle, and the pool throws that original value afterward. Already-in-flight classification/deletion/callback work finishes while the caller is still waiting. Success input order, completion-order callbacks, bounded concurrency, validation, deleteRejected and all Gold/DEMO policies are unchanged.

The same registered callback compiles the entire actual owning TypeScript module with its normal CommonJS/ES2022 settings and replaces only its two archive IO imports with deterministic deferred fakes. The actual classifier and pool execute; no lookalike consumer or substituted outcome is used. The callback is registered in the existing archive blackbox and a normally auto-discovered unit entrypoint. Sockets, DNS, HTTP and fetch are denied.

Final unchanged owning control: baseline exit1 (0.599s), candidate exit0 (0.555s). Five failure phases cover classification/deletion/callback, undefined error and a second peer failure; success checks cover order, concurrency, callbacks, empty/invalid/fractional inputs. The existing unchanged seven-test curation unit family passed on both baseline (0.357s) and candidate (0.427s), using synthetic local archive fixtures entirely inside private SHM. TypeScript strict no-emit checking passed. Exact commands, byte hashes and raw results are retained in the private handoff.

The reviewed repair is applied locally and the registered owning controls pass. Status remains open pending normal final-source deployment gates. These controls prove the component mechanism only, not a historical benchmark cause, fundraising result, real provider deletion or production outcome.

## Human feedback

The user auto-approved infrastructure repairs and reserved context or semantic changes for explicit approval. Preserve every classification/deletion/onResult policy and all Gold/DEMO membership semantics; join all in-flight work before surfacing the original error. Root alone integrates after terminal and authenticated preservation. No new agents or paid actions were authorized.

## Reusable lesson

Seal new worker claims on the first failure and join every admitted worker before returning that failure to the caller.
