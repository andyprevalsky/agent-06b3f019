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
  - KeyError original-native-config.json in verify_pre_service_archive after archive builder rc0
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
  - fleet run 20261027-191440-2597567 owner 49927b5b138945249cb5e040f87159c8
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

### October 27, 2026 recurrence: producer omitted the pre-service proof envelope

Archive searches used `KeyError original-native-config.json` and
`original volume archive recovery wrappers`. This is a recurrence of this
case's producer/consumer contract: the phase-aware consumer was cemented with
hand-built complete archives, while the generic original-volume builder never
carried the native collector's config/provenance sidecars. Capture succeeded,
but the first bad boundary was capture artifacts to generic archive members.

The unchanged historical 2,704-byte packet (SHA-256
071a10dba7b84f579836e89ae3d02179435f20c7c362bdd554abfbbc1f77a996)
was replayed locally through real `verify(archive_only=True)`: it raised
`KeyError: 'original-native-config.json'`. The new registered
`PreServiceArchiveTest.test_native_capture_builder_roundtrip_uses_real_verifier`
ran against parent 05125f70e and failed at the same boundary in 3.152 seconds.
The fixture runs the actual CLI builder and full verifier, with the existing
fixture-only reviewed-source policy; historical replay uses the real policy.

The reviewed adapter preserves the original config, raw nested capture and
native provenance bytes. It consumes the collector's own typed receipt rather
than inventing legacy `capture_complete` or `restored_original_config` fields.
The collector's config digest is canonical JSON; its saved private JSON has a
trailing newline. Legacy receipt validation and source policy stay mandatory.
The regression checks exact archived wrapper bytes, zero credit and no native
release; adversarial checks rehash the outer packet before testing inner
identity, config, capture, absence and native-stop authenticity.

Opened artifact-custody references: OpenClaw
`src/commands/backup-verify-manifest.ts:100-206` retains typed source/payload/config
inventories, `src/infra/backup-create-stream.ts:11-31` seals actual traversed bytes,
and Hermes `scripts/ci/archive_inputs.py:106-145` verifies archived size/digest.
These support preserving and validating complete original evidence; they grant
no Fly authority. No live-agent hot path, per-agent lock or polling is added.

Independent reviewer `ph7cqance5nyhhhfe7rtfkwd9s8h3wf5` returned `GROUNDED`
for approval `polar-k2-i10-native-capture-v1` on base 05125f70e, runtime patch
SHA-256 d89aeee8d0a10711596729f0115e211078d7d1fa1c2fce142f42782e8467fcc0
and test patch a640b3c2775a1107373e5b7c48ae44c0aa5b08b0540502fa061275466753d908.
Review opened every cited reference plus Codex source-ledger content identity
and searched Claude/Kimi for contrary practice. The reviewer independently
reproduced RED in 2.406 seconds, roundtrip GREEN in 2.707 seconds and all 19
owning tests in 56.507 seconds. Only then were the exact reviewed runtime bytes
applied. The unchanged author roundtrip passed in 3.574 seconds.

Author gates on the exact reviewed bytes: owning forensic suite 19/19
(66.438 seconds), prestack recovery 14/14 (1.376 seconds), prelaunch cancellation
6/6 (3.098 seconds), all four new tests five consecutive runs unchanged, gate
registration test, archive validation (1,177 cases), and diff whitespace check.
The owning suite remains registered in both the general test runner and the
deploy structural registry; no new skip or exclusion was introduced.

Private historical GREEN remains pending owner-local replay. No canonical
recovery, new capture, provider mutation, paid benchmark or deployment is
authorized in this lane. The historical native config stays
private on the launch owner's box; its complete environment is never committed
or sent as a shared fixture. The case stays mitigated pending native release.

## Human feedback

Preserve meaningful lifecycle stage endpoints, avoid aggressive inner criteria
or timers, permit genuine task FAILURE, preserve complete truthful originals,
and require exact terminal resource release. Do not fabricate receipts or grant
acceptance credit to recovered or interrupted executions.

## Reusable lesson

Validate each allocation and runtime phase through its existing terminal owner contract while preserving every original byte and the independent final native release audit.
