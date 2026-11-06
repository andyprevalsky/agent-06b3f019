---
id: 2026-11-02-prisma-client-stale-after-comment-only-schema-sync
date: 2026-11-02
title: Generated Prisma client freshness failed after a schema comment changed
surface: harness
component: backend-coverage-dependency-preflight
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The unchanged freshness predicate compared newly formatted schema bytes against a client generated before the main merge
symptoms:
  - Prisma client is stale or unavailable
  - All four coverage phases exited before tests
tags:
  - prisma
  - generated-client
  - dependency-preflight
sources:
  - commit 55e86d4b85240654797187d423a50862216edaab
  - plan:/project/rose-speed-comparison-20261028/nov2-prisma-refresh-rca/HANDOFF.md
repro: node back-end/scripts/assert-prisma-client-current.mjs
status: fixed
---

## Problem

The merged-source backend coverage run stopped all four phases before any tests because the generated Prisma client did not match the current formatted schema. Client and CLI versions both remained5.22.0. No database/runtime failure was established.

## Diagnosis

Gate: INTRODUCED at dependency preparation. The installed schema exactly matched prepared parent1ded38790, while merge55e86d4b8 changed only the Agent.projectId documentation comment. The unchanged predicate passed with the parent schema and failed with the merged schema. The separate synchronization fingerprint was absent; the predicate itself compares formatted schema bytes rather than that marker. Commands, hashes and preserved original phase logs are in the linked handoff.

## Solution

After frontend/shared-client readers became terminal, run the existing serialized sync-prisma-client.sh helper. It generated the matching client and its own fingerprint without changing source, schema or the database. The unchanged actual-root predicate then passed in0.715s. The backend coverage rerun progressed into its real unit/API tests, confirming the original preflight boundary is cleared. Later test failures are separate; this setup repair does not claim their success.

## Human feedback

Preserve active test runs and original failure evidence. Do not regenerate shared dependencies while readers are active, weaken the freshness guard or claim a zero-test failure as coverage success. Freedom and native leases remain untouched.

## Reusable lesson

Strict generated-client freshness can change after documentation-only schema edits. Refresh generated dependencies with the normal lock-owning helper at a reader-free boundary after integrating source, then prove the unchanged predicate before rerunning tests.
