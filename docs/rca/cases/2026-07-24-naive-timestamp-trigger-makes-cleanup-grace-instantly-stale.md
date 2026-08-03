---
id: 2026-07-24-naive-timestamp-trigger-makes-cleanup-grace-instantly-stale
date: 2026-07-24
title: A Postgres trigger wrote session-local CURRENT_TIMESTAMP into a naive column, so Prisma read the cleanup grace as already expired
surface: back-end
component: temporal-workflow-cleanup
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the Postgres trigger writing session-local CURRENT_TIMESTAMP into a TIMESTAMP WITHOUT TIME ZONE column that Prisma then interprets as UTC
symptoms:
  - workflow cleanup grace looks stale immediately
  - terminal Temporal workflow cleanup fires right away instead of after five minutes
  - local workflow cleanup tests are unstable under a non-UTC Postgres session timezone
tags:
  - postgres
  - timezone
  - prisma
  - temporal-cleanup
  - naive-timestamp
sources:
  - PR #875
repro: back-end regression coverage for the workflow cleanup UTC grace
status: fixed
---

## Problem

Local Temporal workflow cleanup tests were unstable, and terminal workflow cleanup
could fire immediately instead of honoring its five-minute grace period.

## Diagnosis

A Postgres trigger wrote session-local `CURRENT_TIMESTAMP` into a `TIMESTAMP
WITHOUT TIME ZONE` column. Because the column is naive, the offset is discarded at
write time, and Prisma then reads the stored value _as UTC_. Under a non-UTC
Postgres session timezone, the value therefore lands hours away from the real
instant — enough that a five-minute grace window looked already expired the moment
it was written. The environment dependence is what made this look like flakiness
rather than a bug: the same code is correct on a UTC session and wrong on any
other. The deep cause is a naive timestamp column carrying an instant that two
layers interpret with different assumed zones.

## Solution

Keep Temporal workflow cleanup grace timestamps in UTC so terminal cleanup does
not fire immediately under a non-UTC Postgres session timezone, with regression
coverage for the UTC grace. Because the fix pins the _written_ value's zone rather
than adjusting the reader, it holds for every consumer of the column and for any
developer or CI host whose Postgres session timezone differs.

## Human feedback

None recorded.

## Reusable lesson

Timing logic that is flaky only on some machines usually means a naive timestamp
column is being written with a session-local clock and read as UTC — normalize to
UTC at the write, not at each reader.
