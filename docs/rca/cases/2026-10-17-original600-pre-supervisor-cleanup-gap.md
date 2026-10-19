---
id: 2026-10-17-original600-pre-supervisor-cleanup-gap
date: 2026-10-17
title: Verified startup export could not close an unstarted supervisor
surface: infra
component: cloudbench-original600-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: sealed-controller cleanup required a supervisor that never started
symptoms:
  - payload deadline expired before supervisor identity publication
  - canonical gate exported the failed startup and joined
  - the original caller retained cleanup ownership indefinitely
tags:
  - cloudbench
  - cleanup
  - startup
  - ownership
sources:
  - commit 59ab01b35aa91521e105a3d48e1587007aa347ad
  - fleet run original600-1792263746104190724
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-startup-finalization.test.py
status: fixed
---

## Problem

Run73 reached its original payload deadline before publishing a supervisor.
The guest launcher failed while decoding a required sidecar, before writing
the supervisor identity or executing the campaign. No task began. The
canonical gate exported the failed startup successfully, but the retained
caller could not advance to controller disposal.

## Diagnosis

The runner's cleanup predicate for a sealed controller required a joined
supervisor. Its exception loop could observe or signal a published supervisor
and consume an existing release, but could not initiate cleanup for a
verified startup that had never published one. The recovered-payload finalizer
also required a completed borrower and a joined supervisor. Neither contract
represented this valid failure state.

The retained step log records the exact original deadline failure inside
`decode_remote_file`, before supervisor publication in the pinned launcher.
The complete canonical archive and manifest retain that log and contain no
supervisor runtime publication. The gate reported export success and exited;
the original caller stayed alive as the cleanup authority.

This identifies a cleanup gap, not the cause of transfer latency or the
observed wall-clock discontinuity. Original timeouts and failed records must
remain unchanged. Search terms were `cleanup_mode`, `supervisor_joined`,
`preallocation_terminal` and `controller-payload-finalization`; the earlier
joined-supervisor recovery does not cover an unstarted supervisor.

## Solution

Add a distinct startup-finalization path that validates the original source,
configuration, live caller, reaped gate, exact prepublication failure and full
verified export. Record explicitly that no supervisor was published or joined.
Invoke the unchanged canonical disposable-controller cleanup once under the
original authority. Verify native release before retiring the exact caller
through its pinned process descriptor. Preserve all prior records and reject
replay, ambiguous ownership, changed exports and any supervisor publication.

The owning tests and actual run73 closure establish this path. Archive
consumers recognize its explicit failure proof without synthesizing a
joined-supervisor result.

## Actual run73 verification

The canonical disposal child exited zero. Its first post-delete Machine GET
returned the exact original incarnation with state `destroyed`, which the
initial wrapper rejected because it accepted only HTTP 404 for a Machine.
The original cleanup and its receipts were preserved. An explicit continuation
validated that closed journal, made only new GET observations, and retired
the exact caller through its process descriptor. The continuation exited
zero with `FAILED_BEFORE_SUPERVISOR`, both supervisor flags false and
`no_effect_replay: true`; the original caller then joined. No task ran and no
successful benchmark was inferred.

The ordinary finalizer must also accept the same exact destroyed incarnation,
while rejecting changed identity/configuration and HTTP 200 null responses.
The historical continuation remains separately bound to its original
producer and immutable cleanup journal.

The closed startup also lacks a guest-imported reservation request. Its unused
reservation reader therefore accepts the actual launch and outer request bytes
only under the verified no-supervisor closure, with an empty claim scan and
exact configuration path and hash bindings. This evidence is labeled
`HOST_BOUND_NOT_IMPORTED`; ordinary archives still require their imported
request. No file is inserted into the original archive.

## Human feedback

Finish the authorized cleanup while preserving the original run, deadline,
resource protections and failure. Do not relabel startup failure as success.

## Reusable lesson

Allocated resources can outlive a startup that never reaches its supervisor.
Represent that state directly; requiring a nonexistent successful startup
milestone prevents otherwise verified cleanup.
