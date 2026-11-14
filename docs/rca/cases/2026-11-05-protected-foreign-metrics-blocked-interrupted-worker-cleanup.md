---
id: 2026-11-05-protected-foreign-metrics-blocked-interrupted-worker-cleanup
date: 2026-11-05
title: A protected foreign tunnel metrics socket blocked quiescent frontend worker cleanup
surface: harness
component: deploy-local-supervisor-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: interrupted_worker treated every occupied port in the possible Hub search window as interrupted worker custody without checking positive unrelated native ownership
symptoms:
  - "local cleanup: interrupted root listener remains"
  - "frontend round12 cancelled native_exit -9"
  - "cloudflared PID 2688937 port 20241"
tags:
  - local-cleanup
  - retained-stack
  - unrelated-listener
  - interrupted-worker
sources:
  - commit 1bd8133c0f47c27012a06ec3a9b48065433ad94d
  - benchmark run 1793253152-2681625-67418
  - agent 01a1a32a-56ed-7043-b8dd-68349792e0b8 isolated evidence /home/boxes/cli-nov05-foreign-listener-repair/.context/foreign-listener-rca/
repro: scripts/tests/foreign-listener-cleanup.test.py
status: open
---

## Problem

The exact round12 frontend receipt is cancelled/-9/incomplete/UNVERIFIED. Its
supervisor reports quiescent with no remaining descendants. The native local
cleanup validator nevertheless refuses port20241, within the worker's possible
Hub search window at base14004 plus5764..6264. The existing rejection was executed
against the actual canonical receipt, request and supervisor sidecar unchanged.

## Diagnosis

The listener is a protected foreign tunnel, not an interrupted frontend child.
PID2688937 directly descends from retained run.sh PID2681868; the parent's Linux
boot/start identity matches the original local-stack-owner record for run
1793253152-2681625-67418. Its native failed_retained benchmark journal and running
services manifest name frontend3802. Tunnel argv targets3802 and both output FDs
point to that run's cloudflared.log. The exact metrics socket20241 is owned by
that child. The root is canonical rose, disjoint from the frontend worker.
Both displayed old wall clocks predate round12; their discrepancy is preserved
and native boot/start identity is used instead of rewriting historical dates.

The validator conflated a potential dynamic Hub reservation with current worker
ownership. Removing listener checks would be unsafe; stopping this protected
service would violate recovery custody. Existing native Hub allocation already
skips occupied ports unless the listener proves the same runs root. No allocator
or runtime repair is needed. Searches used the exact refusal and protected
cloudflared metrics port cleanup. This is a related ownership-admission boundary,
not an application assertion failure or financial repair.

## Solution

Add a typed current foreign-listener observation only to cancelled, owned,
interrupted-worker cleanup. It binds original token/source/root/receipt digest
and a fresh clock, covers every conflicting socket exactly, and is limited to
the dynamic Hub search window. Primary service ports remain strict failures.

Re-read actual process incarnations, direct ancestry, UID, cwd, all listening
socket inodes and FD ownership, and exact tunnel target/output-log custody.
Require a disjoint canonical native benchmark owner, matching parent identity,
explicit failed_retained journal, running services manifest and evidence hashes.
Changed/missing/ambiguous identity, socket or owner evidence refuses admission.
The original supervisor reap, request inventory, listener closure and worker-root
quiescence checks remain mandatory. Neither receipts nor test outcomes change;
reconciliation continues to grant no pass credit. No protected service is stopped.

The actual validator now accepts the exact original receipt with this positive
observation; canonical import is left to the parent. Registered tests use
self-terminating disposable loopback processes, never protected services. Wrong
PID, birth, socket, root, owner, missing proof and primary-port negatives reject.
A native allocator control keeps the occupied socket alive and selects another
Hub port. The full existing cycle suite passes192 tests. Status remains OPEN
pending parent integration and final validation; interrupted tests stay unverified.

## Human feedback

The user prohibited changes to the protected stack, financial fixtures, Freedom,
production/provider/DB actions and existing process signals, and required original
worker quiescence and preventing new validation from stealing the foreign port.

## Reusable lesson

Distinguish a potential dynamic port reservation from actual worker custody using fresh exact native owner and socket evidence.
