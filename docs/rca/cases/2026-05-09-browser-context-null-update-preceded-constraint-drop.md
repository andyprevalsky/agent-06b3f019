---
id: 2026-05-09-browser-context-null-update-preceded-constraint-drop
date: 2026-05-09
title: The BrowserContext migration wrote NULL before dropping NOT NULL, so Render migration deploy failed
surface: back-end
component: prisma-migrations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: 20260508010000_nullable_browser_context_context_id — UPDATE set contextId to NULL before ALTER COLUMN DROP NOT NULL
symptoms:
  - Render passes the TypeScript build and fails during prisma migrate deploy
  - 'UPDATE "BrowserContext" SET "contextId" = NULL violates the contextId NOT NULL constraint'
  - the nullable BrowserContext migration succeeds on a fresh local schema but fails on production data
tags:
  - prisma
  - migration-order
  - not-null
  - render
  - schema-drift
sources:
  - PR #579
repro: back-end/src/tests/structural/browser-context-nullability.test.ts
status: fixed
---

## Problem

Render reached `prisma migrate deploy` and failed while applying the migration
that replaced empty-string `BrowserContext.contextId` sentinels with `NULL`.
Production still enforced `NOT NULL` at the moment the update ran.

## Diagnosis

The migration contained both required operations but ordered them incorrectly:
it updated rows to `NULL` first and dropped the constraint second. A migration
must be valid after every statement, not only in its final intended state, so the
first statement violated the live schema and stopped deployment.

## Solution

Reorder the migration to drop `NOT NULL` before converting sentinel values, and
cement that ordering in the browser-context structural test invoked by the
backend structural gate.

## Human feedback

None recorded.

## Reusable lesson

Order data migrations so every intermediate statement satisfies the constraints
that are still live at that exact point.
