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

Archive one complete encrypted BASE from the existing idempotent stream finalizer,
including authentic input, config, actual model, output and partial/error state.
Keep all plaintext APIs and production guards intact. Model streaming does not
await network archival: a leaf registry tracks exact-agent pending promises;
terminal lifecycle drains the end fixture's exact agent IDs before its fence and
manifest. Failed enabled writes retain a failure that blocks the terminal drain.
Reuse encrypted worker storage and late manifest reconciliation. Resolve stored
Agent.busId with one indexed read, or honor explicit root binding; correct local
root metadata through the existing guarded local updater. Preserve the real
recorded call-start clock in archive metadata so concurrent finish order cannot
change latest-call selection. No model, prompt, task, deadline, concurrency or
provider routing changes. Process-crash durability and arbitrary process-shutdown
joining are not claimed; terminal publication is the tested ownership boundary.

The owning stream-contract suite uses real encrypted local storage and strict
materialization with full messages, schema, config, actual model and output.
It covers all three original call sites, root/child identity, delayed identity
resolution, completed and consumer-closed streams under empty Fly, named Fly and
Render guards. It retains all original local capture assertions. The exact latest
suite fails on the original producer with No archived LLM base calls and passes
on the repaired producer. Native unchanged chat-mode plus normal publisher and
full deployment remain pending; proxy fail/pass alone is not completion.

At 10k agents each write is isolated by root and unique dump identity, with one
indexed identity read and one encrypted submission per call; there is no serial
global uploader, full scan or cross-root fan-in. Pending state scales with actual
in-flight captures, settled tasks are removed, and failures retain one error per
agent until their owning terminal publication can report them. Existing archive
I/O bounds/retries remain unchanged. Golden reference: not applicable (no
approval-gated hunk).

## Human feedback

Preserve original chat PASS and publisher FAIL, strict checks, complete authentic
context, production privacy guards and Freedom. Never fabricate missing history,
change benchmarks, cite a replay as native acceptance, or waive this assignment.
Finish normal deploy through reviewed records closeout and deletion readiness.

## Reusable lesson

Archive model evidence at its owning completion boundary independently of plaintext logging policy.
