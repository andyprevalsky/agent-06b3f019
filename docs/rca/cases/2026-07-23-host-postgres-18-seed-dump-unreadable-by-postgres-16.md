---
id: 2026-07-23-host-postgres-18-seed-dump-unreadable-by-postgres-16
date: 2026-07-23
title: Seed archives created by the host's PostgreSQL 18 pg_dump were unreadable by the isolated PostgreSQL 16 container
surface: harness
component: seed-archive
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "seed-dump creation ran the host `pg_dump` (PostgreSQL 18) instead of the target container's own binary (PostgreSQL 16)"
symptoms:
  - a published seed archive cannot be restored into the isolated Postgres container
  - a deploy gate fails while restoring a previously published seed dump
  - archives produced on the host are unreadable by PostgreSQL 16
tags:
  - postgres
  - pg-dump
  - version-mismatch
  - seed-archive
  - deploy-gate
sources:
  - PR #857
repro: none-recorded
status: fixed
---

## Problem

A deploy-gate RCA found that seed archives were being produced by the _host's_
PostgreSQL 18 `pg_dump` while they are restored into an isolated PostgreSQL 16
container — a newer dump format the older server cannot read. Archives already
published in that state were proven bad and had to be invalidated.

## Diagnosis

The dump step resolved `pg_dump` from the host `PATH` rather than from the container
that will consume the archive, so the archive's format version was determined by
whatever Postgres the developer/CI host happened to have installed. Nothing in the
pipeline asserted that the producing and consuming Postgres versions matched, and
because archives are published for later reuse, one host upgrade silently poisoned
every downstream restore until someone hit the failure.

## Solution

Seed dumps now run the _target container's own_ `pg_dump`, so the archive format is
always one the consuming server can read. Publication is atomic, archives proven bad
are invalidated rather than left in place, and recurring regression coverage was added
(the source does not name its path). This also removes the whole class of
"works on my host, fails in the container" archive failures caused by future host
Postgres upgrades.

## Human feedback

None recorded.

## Reusable lesson

Generate a database archive with the binary of the server that will restore it — never
the host's — and invalidate published archives once they are proven unreadable.
