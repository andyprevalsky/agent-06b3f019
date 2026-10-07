---
id: 2026-10-06-forensic-archive-assumed-one-runtime-phase
date: 2026-10-06
title: Generic failed-owner archive required every allocation to have one runtime shape
surface: infra
component: cloudbench-forensic-retirement
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: generic verify counted every historical allocated Machine as a primary or legacy worker and required service files for every task
symptoms:
  - AssertionError at len(by_machine) == len(rows) + len(unstarted_workers) + len(started_workers)
  - complete original pre-service capture lacks mandatory service files
  - original backend log grew after the exact stopped-provider cleanup receipt
tags:
  - cloudbench
  - exact-owner-recovery
  - forensic-archive
sources:
  - PR #1299 follow-up
  - fleet run 20261007-001156-61479
  - commit 61148634e2dcad07bc951227e91ecf9e69eb47ce
repro: scripts/tests/cloudbench-forensic-quiesced.test.py
status: mitigated
---

## Problem

The failed DAILY50 owner retained 50 task primaries, six verified unallocated
attempts and three normally retired worker attempts. Its complete original
capture contained 48 sealed guests, one guest that stopped before service
startup, and one failed-service guest with native stopped/provider cleanup
proof. The generic verifier required all allocated IDs to appear as primary
or legacy worker rows and required five service files from every task. Neither
condition described the preserved execution phases. This recovery carries zero
benchmark credit, and native release remains a separate obligation.

## Diagnosis

Archive searches used `forensic service stopped mandatory manifest` and
`failed owner pre-service allocation destroyed provider retained`. The source
recipe and forensic ordering cases are relatives: they protect different
boundaries and do not establish this mixed allocation/runtime contract.

The unchanged compact owning assertions on 93dea65 failed at the generic
allocated-Machine count and stopped-provider backend hash equality. Read-only
replay of the complete original archive, owner and all 59 audit records failed
at the same count. Only canonical evidence-file reads were
redirected to private staging; the original registry and run were untouched.

The failed-service guest's later backend capture is an exact extension of the
previous cleanup log. Existing parsers identify the same root, provider session
set and allocation/mutation counters; the suffix has zero root creation, browser
allocation/mutation and payment mutation. The original stopped proof and provider
receipt independently validate against their unchanged original log. Exact hash
equality incorrectly rejected this complete later evidence. Original failed
cleanup states remain preserved; no intermediate cleanup reason is inferred.

## Solution

Generic archive verification reuses normal worker capture verification for the
fresh child subset, retaining honest exit status and startup state. Worker rows
must archive every file required by the unchanged normal capture manifest, and
retired dispositions still require native absence. All allocated IDs remain in
the existing final native absence checks.

Pre-service rows carry the original ACK, exited driver, explicit service/run/log
absence and unchanged original-volume/config/capture bytes. Native executable
and provenance binding reuse the existing source validator and reviewed
before-stack-launch source policy. Native recipe verification is shared with
bootstrap verification; captured checkout verification remains mandatory for
bootstrap callers. No checkout evidence is synthesized.

Failed-service rows reuse exact stopped/provider receipt verification. A later
backend log can reuse the earlier receipt only through exact prefix identity,
unchanged parsed ownership and a suffix containing no new allocation or payment
mutation. Archive readiness continues to report `native_release_verified=false`
and zero credit. Default final absence checks and ordinary native reaping remain
unchanged.

The same full original archive passed with 50 rows, three normal
worker captures, six unallocated attempts and 628 preserved members. Thirteen
compact owning controls, 25 original bootstrap controls and 26 existing generic
forensic controls pass. The owning script is already registered in `scripts/test.sh`,
`run-deploy-structural-gates.py` and the ordinary deploy command. This is bounded
work over one failed owner's archive, outside the agent execution hot path;
10,000 live agents introduce no shared per-agent lock or polling channel.

Independent review cleared the frozen runtime/test candidate at
`61148634e2dcad07bc951227e91ecf9e69eb47ce`, independently passing all nine new
owning controls and replaying the unchanged original archive RED/GREEN. The
candidate's default final verification still rejected the original active
native inventory. Exact native recovery and deployment qualification remain
required before claiming the original resources released or deployed. Status
remains mitigated while that native obligation is outstanding; no new benchmark
execution was performed.

## Human feedback

Preserve meaningful lifecycle stage endpoints, avoid aggressive inner criteria
or timers, permit genuine task FAILURE, preserve complete truthful originals,
and require exact terminal resource release. Do not fabricate receipts or grant
acceptance credit to recovered or interrupted executions.

## Reusable lesson

Validate each allocation and runtime phase through its existing terminal owner contract while preserving every original byte and the independent final native release audit.
