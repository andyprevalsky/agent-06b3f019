---
id: 2026-06-29-postgres-regex-backtracking-ignores-statement-timeout
date: 2026-06-29
title: A catastrophic regex runs past Postgres statement_timeout, so ReDoS on the grep endpoint had to be blocked in the app
surface: back-end
component: data-grep
classification: our-bug
problem_class: other
first_bad_boundary: "POST /api/data/grep — user regex reaches Postgres `~` unbounded; regex backtracking does not hit CHECK_FOR_INTERRUPTS so statement_timeout cannot cancel it"
symptoms:
  - "backend log: grep [56266ms] for a backtracking pattern"
  - "ReDoS greps run 11-56s with DB statement_timeout=3s set"
  - "22 of 200 eval cases fail, 20 of them nested-quantifier patterns"
tags:
  - redos
  - postgres
  - regex
  - statement-timeout
  - grep
sources:
  - PR #668
  - commit 63c164c06
  - memory:project_grep_latency_eval
repro: back-end/scripts/grep-latency-eval.ts
status: fixed
---

## Problem

The DB-backed grep endpoint accepted arbitrary user regexes. A full 200-case eval at
scale 6 (30k rows) ran 200/200 with 178 pass / 22 fail; 20 of the failures were
backtracking patterns (`([a-z]+)*$`, `(.*a){20}$`, `(a|a)*$`, `(\w+\s?)+$`,
`(ab)+c`, `(\d+)+x`, `(.*,){20}$`, `(a+)+$`) across 3 sources. With
`statement_timeout=3s` set and VERIFIED working (a `pg_sleep(5)` cancels at 3005ms
through the backend's Prisma), those greps still ran 11–56s — backend log line
`grep [56266ms]`. A `(\w+) \1` backreference was a ~2.5s outlier. DB work itself was
not the bottleneck: a selective literal was 0.25ms by EXPLAIN and all legitimate
query classes were 8–39ms even at 30k rows.

## Diagnosis

Postgres's regex backtracking loop does not hit `CHECK_FOR_INTERRUPTS`, so a
catastrophic match cannot be cancelled by `statement_timeout` — the cancellation
point is never reached. The DB timeout is necessary but NOT sufficient, which
corrects an earlier note in the record claiming `statement_timeout` was the fix (a
separate earlier claim that Prisma overrides `statement_timeout` was also wrong: it
is respected, verified by `pg_sleep(3)` cancelled at 1029ms). The owned cause is
that untrusted pattern complexity was passed to the database at all, with the safety
argument delegated to a mechanism that cannot preempt it.

## Solution

App-level admission control in `back-end/src/domains/data/service.ts`:
`assertSafePattern()` uses `recheck` (`checkSync`) inside `validateGrepInput` to
reject exponential or polynomial-degree ≥ 3 patterns with a 400 before they ever
reach Postgres `~` (`MAX_SAFE_POLYNOMIAL_DEGREE = 2`, so quadratic shapes like
`meeting.*tomorrow` stay allowed), plus a 1000-character pattern cap. The
`redos-detector` library was evaluated and dropped as too aggressive (it flags
polynomial). Proven by expanding the eval to 275 cases including a 48-case
`realistic_edge` group of money/date/semver/email/phone/invoice/url/handle regexes
the model actually emits: 275/275 pass, realistic_edge 48/48 (zero guard false
positives), redos 24/24 bounded, slowest legitimate query ~95ms
(`back-end/scripts/grep-eval-runs/suite-final.json`).

## Human feedback

None recorded.

## Reusable lesson

Never rely on `statement_timeout` to bound a user-supplied regex — Postgres
backtracking ignores it, so reject dangerous pattern shapes in the application
before the query is issued.
