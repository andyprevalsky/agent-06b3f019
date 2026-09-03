---
id: 2026-09-03-finalize-snapshots-before-async-trace-writes-settle
date: 2026-09-03
title: Trace finalization snapshots R2 before accepted asynchronous artifact writes settle
surface: cross
component: trace-archive lifecycle
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: "back-end/src/providers/traceArchiveLifecycle.ts finalizeAgentOnce — snapshots listArchivedObjects without a durability barrier for writes accepted by agents/helpers/trace_archive.py"
symptoms:
  - Trace archive finalized is followed by POST /api/archive/artifact -> 200 for the same root agent
  - manifest.public.json artifact refs are fewer than the live R2 objects under the same trace-archive prefix
  - finalized R2 bundles contain llm and llm-updates objects that are absent from both manifests
  - planner corpus can report no_llm_traces from a stale creation-time manifest while live LLM objects exist
tags:
  - trace-archive
  - r2
  - async-race
  - manifest
  - data-loss
  - planner-rag
sources:
  - agent d564ef98-ea37-4a81-b78c-cd8e1ce0f865
  - agent a9b2cc2b-4ffd-4f1c-8c82-737c5d344a62
  - agent 256d9baf-de77-45ec-be6e-062061f54d75
repro: "cd agents && source venv/bin/activate && python tests/blackbox/trace_archive.blackbox.py && python tests/blackbox/finished.blackbox.py; cd ../back-end && npx tsx src/tests/unit/trace-archive-reconciliation.test.ts && bash scripts/run-blackbox-tests.sh archive"
status: fixed
---

## Problem

R2 usually receives the encrypted artifact objects, but the finalized encrypted
and public manifests expose an incomplete point-in-time view. On 2026-09-03, a
read-only audit of the 30 newest completed benchmark bundles found 9 with live
objects absent from `manifest.public.json`; all 9 had late LLM artifacts. Across
that sample, 52 `llm/*` context objects plus multiple `llm-updates/*` objects
were unreferenced. No planner-suffixed dump was missing in that sample, so this
defect proves archive incompleteness but does not by itself explain the entire
53k-bundle versus 376-plan corpus gap.

Three individually traced finalized bundles reproduced the ordering directly:
their manifests landed first and 2–4 artifacts landed 3–17 seconds later. The
late objects were present and readable under the same R2 root prefix but absent
from the manifests. Two deployment-cutover failures also had no terminal
manifest because their direct DB status update bypassed the canonical terminal
lifecycle; that is a sibling terminal-path gap, not the cause of the 9/30 stale
manifests.

## Diagnosis

The worker enables `TRACE_ARCHIVE_ASYNC_WRITES=1`. In that mode,
`_submit_archive_job` reserves an in-process slot, submits gzip/encrypt/store to
a thread pool, and immediately returns the reference the object is expected to
have. There is no run-scoped future, persisted watermark, or durability
acknowledgement carried to the backend.

`finalizeAgentOnce` writes the end fixture, calls `listArchivedObjects` once,
and commits that list to both manifests. It cannot distinguish a settled run
from one with accepted executor jobs that have not POSTed yet. Some producers
are ordered after the terminal transition as well: normal completion calls
`mark_finished`, which causes backend finalization, before the completion-SMS
activity archives its provider trace. Benchmark force-finalization can likewise
run while the archived agent is still `ACTIVE`.

The local reproduction at `.context/rca/r2-finalize-race-repro.py` uses the real
worker archive helper, blocks the executor store, takes the same list snapshot,
then releases the store. It deterministically records
`manifest_refs=[]`, `stored_refs=['llm/late.json.gz.enc']`, and fails with
`AssertionError: FAIL: final manifest was committed before the accepted async
artifact landed`.

Archive searches for `manifest artifact arrived after finalization late async
archive` and `final manifest list snapshot async worker writes queue drain`
found the 2026-07-20 creation-manifest fix and 2026-07-21 async configuration
snapshot fix. This incident is related, not a recurrence: neither earlier fix
defined an accepted-write-to-finalize durability contract.

## Solution

The worker now drains archive futures accepted for the root before it requests
the terminal status transition. That reduces the common same-process race while
keeping gzip/encryption/upload work off the event loop.

The authoritative backend contract is cross-process. Finalization writes a
durable R2 fence before taking its snapshot, then serializes manifest writers
with a PostgreSQL advisory transaction lock. A worker artifact that lands after
the fence must acquire the same lock and reconcile both encrypted and public
manifests before its endpoint returns 200. Finalization and reconciliation use
strict R2 reads/lists with bounded request deadlines, so storage failures cannot
silently become an empty successful snapshot. The transaction raises Supabase's
idle-in-transaction timeout locally because a verified rewrite of a media-heavy
bundle can take more than the default window.

`backfill:trace-manifests` audits finalized bundles by comparing their two
manifests with the live object prefix. It defaults to dry-run, retries bounded
failures, repairs only stale finalized bundles under the runtime lock, and
verifies convergence after each rewrite. The 2026-09-03 production pass reduced
the readable finalized snapshot from 1,766 stale bundles / 215,622 missing refs
to one newly racing bundle / two refs; the tail bundle was then repaired and
verified. The pass left 37 legacy encrypted manifests with pre-existing
ciphertext SHA-256 failures quarantined rather than overwriting them.

The planner index builder now clears existing entries for `--rescan-all` and
replaces explicitly rescanned roots, so ineligible roots cannot survive in an
append-only index. An exact rebuild over 55,040 R2 roots produced and published
405 usable plan traces. Queue saturation/process-exit loss and direct DB terminal
transitions remain separately reproducible sibling failure modes; manifest
convergence does not claim to fix them.

## Human feedback

The user requested the production manifest backfill and runtime pipeline update,
and asked for the resulting exact usable-plan count.

## Reusable lesson

Never publish a terminal manifest from a point-in-time object listing until every accepted producer has crossed an explicit durability boundary.
