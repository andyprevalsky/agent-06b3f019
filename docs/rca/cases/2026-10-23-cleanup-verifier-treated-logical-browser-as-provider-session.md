---
id: 2026-10-23-cleanup-verifier-treated-logical-browser-as-provider-session
date: 2026-10-23
title: The owned-cloud cleanup verifier rejected every tree's unmaterialized logical browser row as an unknown provider session
surface: harness
component: cloudbench-guest-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/cloudbench-guest-recovery.py::root_tree_query_sql listed every BrowserSession row in the tree, including logical rows with "sessionId" NULL, and agents/benchmarks/cloud_batch_cleanup.py::exact_root_sessions refused them
symptoms:
  - "exact tree has an unrecognized provider session"
  - "exact provider ownership was not established"
  - "owned cloud evidence finalization failed"
  - "UNKNOWN: no current run artifact produced"
tags:
  - cloudbench
  - browser-session
  - logical-browser
  - cleanup
  - finalizer
sources:
  - benchmark run original600-1792711291636839185 (/benchmark full attempt 3, HEAD 620cb2e10), shard 1
  - agent c74ce999-8d52-401c-af4e-05fe4c806266 (chat-mode, task PASS then finalizer failure)
  - plan: docs/plans/active/code-agent-persistent-sessions.md (logical browser per agent, 2026-10-21)
  - commit 620cb2e10 (reproduced on this revision)
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_exact_tree_query_excludes_unmaterialized_logical_browsers_on_real_postgres
status: fixed
---

## Problem

In `/benchmark full` attempt 3 on feat/rose-user-ui (HEAD 620cb2e10), shard 1
finished 16 PASS and 8 UNKNOWN. The UNKNOWNs were 2 copies each of chat-mode,
background-agent-message-smoke, grep-agent-trajectories-followup and
grep-agent-trajectories-code-tool-status. Each task had actually passed (for
example `chat-mode passed 16s`). The guest then raised
`owned cloud evidence finalization failed: <root>: exact tree has an
unrecognized provider session; ... exact provider ownership was not
established; ... exact payment ownership was not established`. It never
published the cleanup acknowledgement, so the controller recorded REAL NORESULT
(`guest cleanup request failed (HTTP 000)`). Every browser task in the shard
passed. Every failure was a non-browser task.

## Diagnosis

1. `_finalize_owned_cloud_batch` calls `cloud_batch_cleanup.exact_root_sessions`
   before pausing each owned root. It raised, so `before` was never recorded.
   The provider-ownership and payment-ownership failures follow from that one
   exception.
2. `exact_root_sessions` rejects any tree row whose `provider` is not
   kernel/steel or whose `session_id` is not a provider-shaped string.
3. The rows come from `root_tree_query_sql`, which selected every
   `BrowserSession` row in the tree.
4. The branch's migration `20261021180000_browser_logical_identity_verified_credentials`
   made `BrowserSession."sessionId"` nullable. `createAgentTransaction`
   (`createLogicalBrowserInTransaction`) now gives every agent an
   unmaterialized logical browser at creation: `sessionId NULL`, `status
   PAUSED`, `provider kernel`, `logicalOwnerKey agent:<id>`. That is the design
   in docs/plans/active/code-agent-persistent-sessions.md (user direction
   2026-10-21) and is pinned by back-end browser-session-logical.cases.ts.
   Browser tasks materialize the root's row with a Kernel `sessionId`, so they
   passed. Non-browser trees keep the NULL row, so they failed.
5. Deepest owned cause: the cleanup contract treated "a BrowserSession row" as
   "a provider session". The schema's `BrowserSession_unmaterialized_check`
   guarantees a NULL-session row is only an unmaterialized logical identity
   (`logicalOwnerKey` set, status PAUSED/ERROR/CLOSED). Such a row holds no
   provider resource to release or audit.

Repro: `cd agents && python -m pytest -q benchmarks/cloud_batch_cleanup_test.py -k excludes_unmaterialized_logical_browsers`.
On 620cb2e10 it fails with `RuntimeError: exact tree has an unrecognized
provider session`. The test runs the real `root_tree_query_sql` through the
real `run_exact_psql` on a private throwaway Postgres cluster. The cluster has
main's `BrowserSession` table plus the branch migration's exact bytes, and
rows of the product's creation shape.

## Solution

`root_tree_query_sql` now lists provider-backed rows only
(`AND session."sessionId" IS NOT NULL`). This is the single producer for every
consumer: the cloud finalizer, guest recovery, exact-session cleanup and
evidence publishing. They all treat `browser_sessions == []` as "nothing to
release", so the fix restores that meaning for non-browser trees instead of
loosening each validator. Every row that holds a provider session is still
returned and still validated. The same test proves an unknown provider on a
materialized row is still refused, and that the schema rejects a NULL-session
row without a logical owner. The regression runs in the
`benchmark-live-results` deploy structural gate (its `-k` allowlist now names
the test) and in scripts/test.sh "Cloud Benchmark Lifecycle". 10k-agent
behavior: one indexed predicate on the same per-root query; no new reads.

Related gap, not changed here: guest crash recovery's zero-allocation proof
(`scripts/cloudbench-guest-recovery.py`, the backend-log check
`model=BrowserSession operation=upsert`) would also count the logical row's
creation upsert as a BrowserSession mutation. That path runs only after a
guest crash, so it needs its own repro before any change.

## Human feedback

None recorded.

## Reusable lesson

When a schema change lets a resource-tracking row exist without the external resource, make every ownership and cleanup query select only rows that actually hold the resource, at the shared producer.
