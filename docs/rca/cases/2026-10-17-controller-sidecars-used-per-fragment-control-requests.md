---
id: 2026-10-17-controller-sidecars-used-per-fragment-control-requests
date: 2026-10-17
title: Small controller metadata required thousands of control requests
surface: infra
component: original600-payload-transfer
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: transfer_sidecars performs identity and exec observation plus identity and exec write for each 2048-byte fragment
symptoms:
  - original payload transfer deadline expired
  - SUPERVISOR_NOT_PUBLISHED
tags:
  - cloudbench
  - startup
  - transport
sources:
  - commit 59ab01b35aa91521e105a3d48e1587007aa347ad
  - fleet run original600-1792263746104190724
repro: python3 scripts/tests/cloudbench-controller-bulk-transfer.test.py
status: open
---

## Problem

Run73 exhausted its original 90-minute admission clock while transferring metadata. It retained 567 fragment acknowledgements and 1,157,578 bytes. The sealed export establishes failure before the supervisor and before any task workers were launched. No task failure rate can be derived from this startup failure.

## Diagnosis

The transfer path observes every 2048-byte fragment with an identity GET plus exec, then writes it with another identity GET plus exec. Approximately 1000 fragments therefore require approximately 4000 control requests, in addition to chunk assembly and final checks. This expands a roughly 2 MB byte transfer into thousands of serialized service round trips. Recorded read-only identity timeouts and an observation gap are preserved; their underlying cause has not been established.

Archive searches used the transfer/deadline symptom and sidecar/preflight vocabulary. The cold-bootstrap initialization case concerns a different owner conflict; the per-route proxy memory case concerns persistent process multiplication, not this metadata data path.

The registered owning control transfers the same artifact through both actual receivers. The legacy path uses 317 identity GETs and 316 exec POSTs; the bulk path uses one authenticated SFTP upload and two SSH control calls. Both yield identical compressed bytes and the same decoded payload. Other controls cover lost upload and commit responses, partial uploads, cancellation, exact child join, changed native identity/configuration, unsafe archive members and conflicting existing destinations. This establishes the request-amplification mechanism, not the cause of the long observation gaps or a successful original600 outcome.

## Solution

The new normal path uses one bounded authenticated upload of the existing compressed metadata, followed by exact hash verification and exclusive publication. Unknown uploads and commits are observed without replay. The original source/incarnation bindings, original clock, cancellation and child-join rules remain in force. Historical fragment recovery remains attached to its original source.

## Human feedback

The user asked to step back, simplify startup, show how it works, and explain repeated full-parallelization failures. The next launch remains held for this architectural correction; task count, concurrency and timeout contracts are unchanged.

## Reusable lesson

Use a data-transfer channel for a byte payload; task concurrency should not multiply or conceal serialized control-plane work.
