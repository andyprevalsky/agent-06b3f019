---
id: 2026-11-09-backend-llm-capture-omitted-encrypted-archive
date: 2026-11-09
title: Backend completions omitted encrypted root-bound LLM archives
surface: back-end
component: llmDump
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: back-end/src/providers/llmDump.ts lacked an encrypted archive producer independent of its plaintext production guard
symptoms:
  - "No archived LLM base calls"
  - "Archived LLM dump recovery failed"
tags:
  - chat
  - evidence
  - archive
sources:
  - commit 889f69816fa41c0c98f818160cd07a46e7df1d46
  - agent 877cbc7e-7199-4a62-a7c5-3cb8a85be8bb
repro: back-end/src/tests/blackbox/llm-stream-contract.blackbox.ts
status: open
---

## Problem

Original native chat-mode passed, controller exit 0, cleanup verified. Its required
normal publisher exited 1 with No archived LLM base calls. Original campaign:
13 scheduled, 11 PASS, one mass failure and one AgentCard skip. These outcomes
and their original clocks are immutable historical evidence. A new passing run
will not reconstruct the missing original provider context.

All 23 authenticated private archive parts and 1948 member hashes were verified
before repair edits; restoration is isolated under ignored
.context/assigned-pr1885-failures/original. Native backend logs retain three
completed direct-Cerebras calls (router, after-search router, generator), actual
qwen-3.8-27b. Captured strict listing has five objects and zero LLM bases.
No report_bug occurs in the retained root transcript. Original effective
FLY_APP_NAME at capture entry remains UNRECORDED. Empty-Fly suppression is a
reproduced mechanism, not a retroactive claim about that original process.
No retained full original context has been found; global irrecoverability is
not proved. Raw logs remain private.

## Diagnosis

Path: existing chat task -> chat completion builders -> real Rose wrapper ->
backend LLM capture -> encrypted root archive -> strict materializer -> normal
publisher -> durable frontend and last-call HTML.

The original backend producer writes only local JSON and returns null for any
defined Fly identity or NODE_ENV=production. It never submits an encrypted base
or output update. Its local JSON also lacks root_agent_id and dump_id required
by the strict consumer. The deepest owned gap is a missing producer contract;
weakening the consumer or enabling plaintext production dumps cannot repair it.
The Python producer already archives independently of its plaintext policy.

Owning-suite reproduction command, before and after:
cd back-end && env -u FLY_APP_NAME NODE_ENV=test node --import tsx src/tests/blackbox/llm-stream-contract.blackbox.ts
The new existing-suite case completes the real client's fixture response then
fails strict materialization with exactly No archived LLM base calls before the
fix. Controlled empty-Fly, named-Fly and Render environments are prospective
reproductions, never invented original runtime metadata.

Gate: NOT_INTRODUCED relative to e34666de80199bec9cd671aa1d992a5ac0807a37 and
original failed d792e59539b453753d052fd9fb00a497f98ed930: retained same-guest
DEVELOPMENT startup and liveness-disabled event exclude the sole changed runtime
path in originating PR1885. Sixteen owning-path source files are identical.
That attribution does not release this assigned repair.

Archive searches: No archived LLM base calls; chat mode dump archive missing
context. Read the September 11 missing-binding case: related symptom, different
boundary (current builders already bind agent identity). Historical capture
cause remains open where effective environment was not recorded.

## Solution

Add encrypted base and final-update capture to the existing wrapper; await
completion so stream return/error/consumer close cannot leave a detached write.
Keep local dump functions and their Render/Fly guards intact. Reuse encrypted
worker artifact storage, including late manifest reconciliation. Explicit root
binding is accepted; otherwise resolve stored Agent.busId with a single indexed
identity read, rather than treating every child as its own root. Retain original
provider errors and best-effort capture behavior, with safe identity-only failure
logs. No model, prompt, task, deadline, concurrency or provider routing changes.

The owning stream-contract suite exercises the real encrypted storage and strict
materializer with full messages, schema, config, actual model and output; it
keeps all original local capture and consumer-close assertions. Native unchanged
chat-mode plus normal publisher acceptance and full deployment remain pending;
proxy fail/pass alone is not completion.

At 10k agents capture is isolated by root and unique dump identity, one indexed
identity read and two encrypted artifact submissions per call, no shared global
queue, cache, full scan or fan-in. Existing late-manifest reconciliation applies
only after finalization. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

Preserve original chat PASS and publisher FAIL, strict checks, complete authentic
context, production privacy guards and Freedom. Never fabricate missing history,
change benchmarks, cite a replay as native acceptance, or waive this assignment.
Finish normal deploy through reviewed records closeout and deletion readiness.

## Reusable lesson

Archive model evidence at its owning completion boundary independently of plaintext logging policy.
