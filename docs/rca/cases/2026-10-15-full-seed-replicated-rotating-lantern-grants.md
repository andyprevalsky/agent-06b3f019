---
id: 2026-10-15-full-seed-replicated-rotating-lantern-grants
date: 2026-10-15
title: Full seed treated a rotating Lantern grant as a replicable integration snapshot
surface: harness
component: seed-local-integration-credentials
classification: our-bug
problem_class: other
first_bad_boundary: syncIntegrations selected Lantern rows into both full-user and full-pool arrays before copying Integration.config to an independent database
symptoms:
  - Full seed copied a synthetic encrypted rotating Lantern grant into a mocked target
  - A dedicated local Lantern connection was eligible for replacement by the source snapshot
  - Direct credential copying admitted Lantern rows in a mixed input batch
sources:
  - commit c6117542139ec0256f47de02a53e68a321d8e26a
  - task .context/lantern-seed-review/.context/seed-lantern-rca/full-seed-and-defense-red.log
  - task .context/lantern-seed-review/.context/seed-lantern-rca/final-part3.log
tags:
  - seed
  - oauth
  - credential-ownership
  - lantern
repro: cd back-end && node --import tsx src/tests/blackbox/seed-local.part3.blackbox.ts
status: fixed
---

## Problem

Full seed selected every integration for the seed user and every shared-pool
integration. `syncIntegrationCredentials` then copied the entire config by its
natural identity into another database. Lantern refresh grants rotate and have
one durable owner; copying the encrypted envelope creates an uncoordinated
refresh peer and can overwrite a separately connected local grant.

No actual production grant import or native benchmark failure is claimed here.
The causal reproduction uses only synthetic credential markers and mock storage.

## Diagnosis

The registered seed-local.part3 owner extracts the actual `syncIntegrations`
declaration, following the existing seed-credential-retry AST replay convention.
It executes that production orchestration and the actual credential writer with
only source/target storage and user hydration mocked. No CLI clients, environment
files, database, provider, or real credential is imported.

Before the fix the owner exited1 with `full seed replicated a rotating Lantern
grant into the mocked target`. A second control placed an ordinary credential
before Lantern in a direct writer batch; it also failed because no rejection
occurred. Silently filtering only inside the writer would be incorrect: pool
eligibility uses the user-row count to partition returned local IDs.

Archive searches used `syncIntegrations rotating credential` and `credential
replication refresh token local database`. The September27 guest compute seed
case is related credential-authority history, not this exact Lantern defect.
The OpenClaw read-only reference coordinates historical refresh peers and
excludes selected/external ownership from shared persistence; preventing new
uncoordinated replicas is the coherent smaller solution here.

## Solution

Exclude exactly `lantern_people` from both full-user and full-pool queries,
before array lengths, counts and pool mappings are computed. Compute-only name
filters are unchanged. The common writer additionally validates the complete
batch and rejects any Lantern row before any upsert; it never silently changes
cardinality. Existing compute-only deletion already preserves local Lantern.

The same owner now passes5/5. Controls cover a dedicated local Lantern grant,
foreign Lantern pool rows, ordinary AgentCard copying only in full mode, compute
overlays, local primary-key preservation, exact pool local-ID mapping, copied
counts, and mixed-batch zero writes. The affected part2 source contract passes20/20
and the domain-scope owner passes9/9. No assertions, budgets or provider policies
were relaxed. These existing blackbox files are normally discovered by the
backend runner and covered by the deployment backend stage.

## Human feedback

None recorded.

## Reusable lesson

Exclude non-replicable credentials before deriving synchronization cardinality;
fail closed at the shared writer without silently shifting caller ID partitions.
