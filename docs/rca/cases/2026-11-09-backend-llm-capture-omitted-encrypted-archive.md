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
await network archival: a leaf registry tracks promises by actual agent and explicit archive root;
terminal lifecycle drains that root and the end fixture's agent IDs before its fence and
manifest. Failed enabled writes retain a failure that blocks the terminal drain.
Reuse encrypted worker storage and late manifest reconciliation. Bind root identity explicitly in completion options from the already-loaded
parent tree (the existing bounded, same-user graph resolver for descendant chat)
or the freshly created chat root. The common completion capture never queries the database
and only explicitly root-bound calls opt into encrypted archival. This avoids
opening database pools in previously offline completion clients and avoids
expanding archival to unrelated credential/SMS call sites. Local dumps receive
correct root metadata at entry, without a later lookup or rewrite. Preserve the real
recorded call-start clock in archive metadata so concurrent finish order cannot
change latest-call selection. No model, prompt, task, deadline, concurrency or
provider routing changes. Process-crash durability and arbitrary process-shutdown
joining are not claimed; terminal publication is the tested ownership boundary.

The owning stream-contract suite uses real encrypted local storage and strict
materialization with full messages, schema, config, actual model and output.
It covers all three original call sites, explicit root/child identity, no implicit
database access, completed and consumer-closed streams under empty Fly, named Fly and
Render guards. It retains all original local capture assertions. The exact latest
suite fails on the original producer with No archived LLM base calls and passes
on the repaired producer. Native unchanged chat-mode and the normal archive-backed
publisher now pass on repaired source; full deployment remains pending. Proxy
fail/pass alone is not completion.

At 10k agents each write is isolated by root and unique dump identity, with zero
database identity reads in the common completion wrapper and one encrypted
submission per bound call; descendant chat routing uses the existing bounded
same-user parent walk rather than a global lookup; there is no serial
global uploader, full scan or cross-root fan-in. Pending state scales with actual
in-flight captures, settled tasks are removed, and failures retain one error per
agent/root for the process lifetime so reporting cannot erase a lost call. Existing archive
I/O bounds/retries remain unchanged. Golden reference: not applicable (no
approval-gated hunk).

Historical candidate outcome proof: unchanged chat-mode passed on f52e5708c8ec8c840176cfec9b1a554ea8f34f55,
then passed again on combined stabilization source fc731e92a72139e4d321784b02d6beebe855cd85.
The second run recorded defined-empty Fly identity in the actual backend process,
wrote no local plaintext root dump, and passed the normal full publisher through
strict encrypted archive recovery: three genuine complete bases, all three chat
call sites, eight frontend messages verified in a fresh browser, durable last-call
HTML, and native clean benchmark/stack teardown. This controlled environment record
applies only to the new run; original effective environment remains unrecorded.
The first premature second-run publisher invocation failed because run.json was
not finalized yet; that failed invocation is retained separately, then the identical
command passed on terminal artifacts. No skip flags or synthetic histories.
The existing archive suite also fails with terminal drain removed and passes
unchanged after restoration; delayed child registration and failed-writer outcome
are checked through actual direct finalization, in addition to stream coverage.
The explicit-root simplification changes runtime source again, so those native
roots are historical candidate evidence. Fresh native acceptance on the final
combined source is mandatory and pending. Full deployment and independent
additional-gate attribution remain in progress.

Latest source-bound acceptance on cc11dc60c2db1b1a2869425bd2f07ce0a7662831:
unchanged native chat-mode passed in 15.6 seconds, root
013465d1-2a9d-47c9-b1ac-1dab8e7d06b4. The normal full publisher exited 0,
verified eight frontend messages in a fresh browser and recovered three authentic
complete encrypted BASEs with all three call sites. Independent audit verified
seven runtime files and cached encrypted/plaintext/materialized hashes. Five real
startup EventLoopStall diagnostics preceded the task; no request handler/provider
error was recorded. Native chat controller exit0 and cleanup are verified. The
full campaign separately had thirteen PASS and one mass FAIL, with all task/canary
cleanup verified. This pair does not cover later source changes or completed
deployment. Original capture-time environment/context gaps remain open.

## Human feedback

Preserve original chat PASS and publisher FAIL, strict checks, complete authentic
context, production privacy guards and Freedom. Never fabricate missing history,
change benchmarks, cite a replay as native acceptance, or waive this assignment.
Finish normal deploy through reviewed records closeout and deletion readiness.

## Reusable lesson

Archive model evidence at its owning completion boundary independently of plaintext logging policy.

The first deploy sweep retained an additional auth-options database-admission
failure (17 passed, one failed) and later refused smoke because the coordinator
source had advanced beyond that frozen snapshot; no smoke task executed in that
refusal. Neither result is a PASS. A matched original-main coverage experiment
is collecting server capacity/ownership evidence; a baseline auth-options PASS
alone does not establish introduced causation. Separately, the owning stream
suite reproduced the candidate's unwanted implicit Prisma access and passed
unchanged after root identity moved to existing caller data. No server cap,
pool limit, test concurrency, task or timeout was changed to hide pressure.

The next explicit-root native task on 9fae724a72a259bc0eb6798931775f35b140c16c
retains native PASS and publisher PASS, but is not healthy acceptance: its handler
logged accumulateChatLlmUsage is not defined after a lint-driven helper extraction
missed that local import. Typechecking independently reproduced TS2304 at the same
call. The import was corrected; a fresh typecheck and native run are required.
That run's one archived router call and two frontend messages are preserved as
actual evidence, never relabeled as a full healthy chat trajectory.

Final runtime-source acceptance on d4905c570c555e740acb084b029a72228a64a496:
unchanged native chat-mode PASS, no chat-handler errors, three complete root-bound
archived bases (initial router, after-search router, generator), and normal full
publisher PASS through archive recovery with no local plaintext dump. A fresh
browser verified eight frontend messages and the durable last-call HTML. Native
benchmark and stack cleanup receipts both report clean. Existing compaction
regression also failed on missing root binding and passed unchanged after the
metadata path was completed; compaction prompts and thresholds are untouched.
These facts supersede pending final-native acceptance, not the original failure
or the unhealthy intermediate candidate's native grades. Full deploy remains open.

The exact-head CodeRabbit review on 8485406 exposed a descendant-chat binding
gap: bus IDs may be absent or custom. The existing chat-router public-service
fixture reproduced missing bases for the actual parent root, then passed with
the same assertions after parent-tree resolution. Capture ownership now indexes
both the explicit archive root and actual agent, so root publication observes
writers even outside the collected parent-ID inventory. The existing stream
contract first failed its root failure check, then passed, including repeated
drains preserving the original error cause. Failures deliberately remain sticky:
deleting a failure merely because it was read would let a later finalization
certify a permanently incomplete archive. The process-lifetime failure registry
remains an explicit outage-pressure limit; this is no claim of arbitrary crash
or unbounded-load durability. All three existing owning suites passed together.
Fresh full native acceptance on this reviewed stabilization source is pending.


## Later source-bound acceptance retained before stabilization

On 1f81aab080d05ec4133de7ca0964b85aaf1fc9d0 the unchanged native chat-mode
passed in 16.1 seconds at root 00b5ec12-022c-4840-aeab-64f729c65760. The normal full
publisher exited 0 and verified 8 messages in a fresh frontend browser, durable
last-call HTML and 3 genuine complete encrypted BASEs. Independent 24-check audit
authenticated retained ciphertexts, plaintext/materialized hashes, all 3 call
sites, full messages/schema/config/model/output and exact frontend response.
Five startup stalls preceded the task; no task handler/provider error occurred.
Controller exit 0 and stack cleanup are verified. The same source's native smoke
campaign passed14/14 tasks with all 15 task/canary lifecycles verified.

This pair is historical source-scoped evidence after any later stabilization;
new source requires its own original native acceptance and full normal publisher.
Original native chat PASS/publisher FAIL, missing effective capture environment
and missing full original provider context remain unchanged. No arbitrary crash,
shutdown or outage-pressure durability is claimed. Deployment remains open.
