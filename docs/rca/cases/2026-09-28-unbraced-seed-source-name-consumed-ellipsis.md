---
id: 2026-09-28-unbraced-seed-source-name-consumed-ellipsis
date: 2026-09-28
title: Seed memory gate's system Postgres status line consumed an ellipsis as a variable name
surface: harness
component: seed-memory-ratchet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/measure-seed-memory.sh system Postgres source restore status line
symptoms:
  - "SRC_DB…: unbound variable"
  - "source Cookie rows (userId=1f85ff25-6e29-4c1b-8739-f917bd101a30): 0"
tags:
  - seed-memory
  - system-postgres
  - shell
sources:
  - commit 67e0d2b93407644a1908e9bfb2cad48d16b778e4
repro: scripts/tests/seed-memory-ratchet.test.sh
status: fixed
---

## Problem

The five-run cold seed gate failed on a Mac whose Docker engine was unavailable.
The supported `ROSE_USE_SYSTEM_PG=true` path created the source database, then
Bash reported `SRC_DB…: unbound variable` at its progress line. The subsequent
Cookie count was zero, so the gate could not measure a real seed. A separate
manual restore of the same cached dump returned 21,244 Cookie rows for the
required development user, ruling out an empty fixture.

## Diagnosis

Archive searches for `SRC_DB… unbound variable seed memory system postgres` and
`shell unicode ellipsis variable expansion` found no prior case at this
boundary. The input path was `ROSE_USE_SYSTEM_PG=true` → source database
creation → shell progress line → `pg_restore` → source fidelity check. The
first bad boundary was `"$SRC_DB…"`: Bash read the adjacent Unicode ellipsis
as part of the unbraced variable name under `set -u`. The status line failed
before the normal restore sequence could proceed.

The isolated reproduction executed the actual status line from the original
revision with `SRC_DB=fixture SUMMARY=/dev/null bash -u -o pipefail`; it failed
with `/dev/stdin: line 1: SRC_DB…: unbound variable`. The same extraction and
execution on the fixed worktree printed `restoring source into fixture…` and
exited zero. The permanent regression in `seed-memory-ratchet.test.sh` executes
that line under `nounset`.

## Solution

Brace the variable as `${SRC_DB}` before the ellipsis. The regression checks
the shell's actual expansion, rather than accepting the line as plain text.
The full five-run gate is rerun with a cached production dump and system
Postgres; its result is recorded separately in the deploy run.

## Human feedback

None recorded.

## Reusable lesson

Brace shell variables when punctuation or non-ASCII text immediately follows
their names, especially in paths exercised only by a fallback environment.
