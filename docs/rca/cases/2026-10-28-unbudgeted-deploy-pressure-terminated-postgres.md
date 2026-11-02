---
id: 2026-10-28-unbudgeted-deploy-pressure-terminated-postgres
date: 2026-10-28
title: Concurrent deploy pressure terminated an IndexedDB upload's Postgres backend
surface: infra
component: deploy-pipeline
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: Unbudgeted concurrent deploy lanes exhausted whole-machine memory headroom; the platform watchdog selected a Postgres backend.
symptoms:
  - "Raw query failed. Code: 57P01"
  - "FATAL: terminating connection due to administrator command"
  - "expected 2 origins upserted, got 0"
tags:
  - indexeddb
  - postgres
  - memory-watchdog
  - deploy
sources:
  - PR #1627
repro: node --import tsx back-end/src/tests/blackbox/run.ts indexeddb-upload-memory-diagnostics
status: open
---

## Problem

Coverage shard2's treatment upload died while binding49.9MB of JSON to Postgres. The ordinary test message emphasized the256MB V8 heap assertion but did not attribute the independent Postgres termination or show local watchdog receipts. The original failure remains OPEN pending the resource owner's sized sweep; this cluster's completed change is diagnostic only.

## Diagnosis

Archive searches: `57P01 terminating connection administrator`, `concurrent database fixture termination isolation`, and `57P01`. No matching prior cause found; unrelated environment-isolation cases were leads only.

Critical path: deploy lane admission -> total host memory pressure -> platform watcher victim selection -> Postgres SIGTERM -> bindUploadDocument SQLSTATE57P01 -> child exit1 -> missing stored origins. The fixture memory sampler only measures RSS and never sends signals.

The watchdog at /run/boxes-memory-terminations.jsonl recorded postgres hostPID1711139 TERM at2026-10-28T17:48:09.839Z, whole_machine, MemAvailable1007181824. Docker logged PID5209's termination during INSERT INTO idb_upload_ingest_doc at17:48:10.447Z. NamespacePID was not retained, so historicalPID identity is correlated, not independently mapped. Six lanes overlapped the event. Host samples dipped to906.29MB available; load1 peaked39.84 on8CPUs. Per-lane ru_maxrss cannot establish simultaneous process-tree memory.

Safe local replay of installed watcher functions with private fake proc/cgroup roots demonstrated that a modeled out-of-slice heavy process is excluded from candidates and postgres is selected; relocating that same process into the watched slice makes it the selected victim. All signals were captured to a private file. This replay proves the selection mechanism, not actual lane memory or successful deployment.

Inherited author additionally reproduced the exact57P01 by terminating only the upload session on its own isolated database: 8/10 assertions passed; treatment and stored-origin assertions failed. Logs: /var/tmp/deploy-1627/rca/indexeddb-57p01/repro-terminated.log and terminator.log.

## Solution

Scheduling is owned by pipeline-resources. This change extracts the existing child-failure formatter and appends an explicit Postgres termination diagnosis plus time-window-matched TERM/KILL postgres receipts. It labels the receipt correlation honestly, tolerates missing platform logs, ignores stale/future/unrelated/malformed records, and preserves every ingest assertion and its failure exit.

The registered diagnostic regression was run on the original formatter and failed with `0 passed, 1 failed, 0 not run, 1 total`; the same command passes after the repair with `1 passed, 0 failed, 0 not run, 1 total`. The unchanged upload domain independently passed18775ms on the isolated database. This is NOT a sized-sweep proof. Scoped ESLint and formatting pass. No prompts, runtime product semantics, timeouts, skips, or schemas changed. The new *.blackbox.ts is discovered by the same backend runner used by /deploy.

Golden reference: not applicable (no approval-gated hunk). No per-production-agent runtime cost; additional local-log parsing occurs only when this test's child fails with57P01. Remaining risk: original incident unresolved until the sized sweep passes; platform log namespacePID remains an observability gap.

## Human feedback

User narrowed ownership to indexeddb-upload-memory* diagnostic attribution and handed scheduling to pipeline-resources. User required accurate distinction between diagnostic completion and original outcome. Preserve Freedom, shared processes, and all original assertions.

## Reusable lesson

Report process-termination evidence alongside failed memory assertions without converting correlated watchdog receipts into proven backend identity or mistaking diagnostics for a resource fix.
