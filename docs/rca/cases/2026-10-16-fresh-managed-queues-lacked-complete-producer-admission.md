---
id: 2026-10-16-fresh-managed-queues-lacked-complete-producer-admission
date: 2026-10-16
title: Fresh managed queues lacked immutable root starts and incoming continuation membership
surface: back-end
component: temporal-managed-producers
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: The real pointer service exposed a managed destination without source identity and ordinary root starts reused the logical agent workflow ID
symptoms:
  - managed pointer read without source identity succeeded
  - ordinary managed root starts used the logical agent ID without reject duplicate policy
tags:
  - temporal
  - deployment
  - queue-admission
  - continue-as-new
sources:
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
  - plan:.context/lantern-producer-f3315/.context/producer-rca/final-manifest.json
repro: cd back-end && node --import tsx src/tests/unit/managed-workflow-producers.test.ts
status: open
---

## Problem

Reusable physical banks require a complete producer boundary for each fresh
queue generation. Existing retirement correctly refused UNKNOWN legacy coverage,
but no production producer established safe future coverage. Root starts retained
ALLOW_DUPLICATE semantics, while cross-queue continue-as-new bypassed start rows.
This is a local source/owning-boundary finding, not a claimed production incident.

## Diagnosis

Archive searches used the literal "Legacy producer/start coverage is unqualified"
and "queue retirement late workflow start continuation". The earlier retired-queue
admission case is related, but its fixture's externally qualified certificate does
not prove a complete new-generation producer transition. The registered actual
pointer service and Temporal start wrapper failed before runtime edits: missing
identity was accepted, and the native start used logical-agent as its workflow ID.

## Solution

Managed roots now durably reserve one physical ID under the agent generation
lock and use REJECT_DUPLICATE while preserving logical agent arguments, deadlines,
and existing explicit immutable child/replacement IDs. Clearing Agent fields alone
does not authorize a new physical ID: all prior per-agent START references need
exact native terminal witnesses; unresolved membership blocks. With no references,
the original logical Workflow ID is probed, and only canonical NOT_FOUND or a
terminal native chain permits the first new physical identity. Terminal proofs
are persisted on the exact acknowledged member, so expired history is not needed
forever. Fresh queue initialization
requires the current DB-clock deployment lease and an exact owned deployment job;
identical resume preserves incarnation, UNKNOWN and retired gates cannot upgrade.
Only the current published managed destination admits starts.

The pointer activity sends native workflow/run identity. The backend verifies the
native chain and commits incoming continuation membership before returning a new
managed destination. Retirement reconciles both starts and incoming continuations;
an unfinished source or a chain still on the target blocks retirement. Legacy
identity-free reads fail closed only after a managed target is active. Explicit
internal observation-only reads support activity draining without granting CAN.

## Verification

The identical registered command failed before and passed after. Additional
registered tests cover actual HTTP middleware, concurrent/held root starts,
unchanged SDK arguments and explicit replacement IDs, staged zero-wire rejection,
lease/job/source validation, exact resume, UNKNOWN preservation, and incoming-chain
retirement. A real isolated Postgres schema exercises production transactions and
advisory locks. The normal activity-generation-drain owner checks identity headers
and observation behavior. These producer controls used injected native clients;
no live Temporal or deployment operation ran. A separate baseline test was
mistakenly launched against production PostgreSQL; its invalid result, exact
fixture cleanup, and local rerun are recorded in
`2026-07-13-local-test-db-resolver-fails-open-to-shared-postgres.md`.

## Limitations

Status remains OPEN pending independent integration and native qualification.
Before the first managed pointer, the sole rollout owner must prove the complete
new Render deployment and at least 375 seconds of old-instance drain. A protocol
constant or one HTTP response does not establish that transition. Original legacy
queues remain served and UNKNOWN. Native describe currently occurs on each
workflow pointer fetch; no 10k-agent throughput claim is made. No workflow prompt,
continue-as-new arguments, terminal policy, or visibility-zero waiver changed.

## Human feedback

None recorded.

## Reusable lesson

Qualify every way work can enter a new queue before allowing that queue to retire,
and retain the native execution identity independently of mutable agent fields.
