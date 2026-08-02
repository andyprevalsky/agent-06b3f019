---
id: 2026-06-29-regex-validated-as-js-but-executed-as-postgres-are
date: 2026-06-29
title: Grep validated patterns with JS `new RegExp()` but executed them as Postgres POSIX ARE, so a named group 500ed
surface: back-end
component: data-grep
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "back-end/src/domains/data/service.ts — validation dialect (JS RegExp) differs from execution dialect (Postgres POSIX ARE)"
symptoms:
  - "(?<grp>phase)-17 passes validation then returns HTTP 500"
  - Postgres regex error surfaces as a 500 instead of a 400
  - "named-group and inline-flag patterns crash the grep endpoint"
tags:
  - grep
  - regex-dialect
  - postgres
  - http-500
  - input-validation
sources:
  - PR #668
  - commit 63c164c06
  - memory:project_grep_latency_eval
repro: back-end/scripts/grep-latency-eval.ts
status: fixed
---

## Problem

`POST /api/data/grep` validated the caller's pattern with JavaScript
`new RegExp()` but executed it with Postgres POSIX ARE. A named-group pattern such
as `(?<grp>phase)-17` is valid JS, so it passed validation, then crashed Postgres
and returned HTTP 500 to the client.

## Diagnosis

Two different regex engines sat on either side of the same request: the validator
accepted the JS dialect's superset, and the executor rejected constructs JS allows.
Any dialect divergence therefore became a 500 rather than a 400 — the service told
the caller "server broke" for what was in fact an unsupported input. (A related
belief that Postgres rejects lookbehind turned out to be false — Postgres 16 accepts
it — so the only real divergences were the ones the eval actually exercised.)

## Solution

Normalize toward the execution dialect and classify the remaining errors correctly,
in `back-end/src/domains/data/service.ts`: `extractInlineFlags()` folds `(?i)` into
the `-i` flag, `stripNamedGroups()` rewrites `(?<name>X)` → `(X)` for the Postgres
`dbPattern` (the match is boolean, captures are unused), and
`isPostgresRegexError()` maps any SQLSTATE `2201B` to a 400 instead of a 500. The
275-case eval after the fix records dialect 500s = 0.

## Human feedback

None recorded.

## Reusable lesson

Validate user input against the dialect that will EXECUTE it, and map the
executor's own syntax errors to 400 — validating with a different engine turns
unsupported input into a 500.
