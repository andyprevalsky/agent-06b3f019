---
id: 2026-11-03-scheduled-script-eligibility-after-batch-limit
date: 2026-11-03
title: Whitespace scripts starve bounded maintenance scheduling
surface: back-end
component: project-maintenance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: findNightlyDue and findGithubPollDue filter literal empty text before LIMIT while startMaintenance uses trim
symptoms:
  - 50 legacy whitespace rows cannot starve valid script
  - legacy blank scripts excluded before limit
tags:
  - maintenance
  - scheduling
  - ownership
sources:
  - PR #1634 review 5746689291
  - commit ca44d84711aafd6972329ebca7beafa02e75f8b4
repro: back-end/src/tests/blackbox/project-maintenance-settings.blackbox.ts
status: fixed
---

## Problem

Whitespace scripts starve bounded maintenance scheduling. The review identified the boundary on the frozen PR1634 source.
No corresponding maintenance module exists on compared main713f9cbf; this is
an introduced feature defect, not evidence of an external outage.

## Diagnosis

findNightlyDue and findGithubPollDue filter literal empty text before LIMIT while startMaintenance uses trim. The private harness executes actual transpiled maintenanceStore
functions and the extracted actual maintenanceData function. Original source
passes the losing-CAS control and fails the other five controls; candidate
passes all six. The SQL fake models eligibility before LIMIT but does not
establish PostgreSQL parsing, real transaction isolation or schema correctness.
Exact commands and raw logs are retained in nov3-review-fixes/maintenance.

Archive searches: maintenance whitespace starvation; empty script nightly batch. Six total searches retained in archive-searches.log.
Related maintenance-clean-template and custody cases have different first-bad
boundaries; no exact recurrence established.

## Solution

Filter complete JavaScript whitespace before both SQL batch limits; normalize new blank writes while retaining nonblank bytes and legacy data.
Permanent existing-owner regressions are prepared, including legacy blank
records, original poll interval/monotonicity, losing CAS, expired takeover,
late publication/completion and retained snapshot custody. The DB-backed owner and shared-source validation are recorded below; the
complete release still requires its independent gates.
No production data mutation, new provider call, timeout change or assertion
weakening is part of the candidate. Golden reference: not applicable (ordinary
maintenance bookkeeping, no LLM/agent recovery hunk).

## Human feedback

The user instructed completing deployment and fixing blocking issues. Existing
leases, active jobs, credentials and Freedom remain protected.

## Reusable lesson

Evaluate the same eligibility predicate before limiting a scheduled batch.

## Integrated verification

The exact normal owning command in `nov3-review-fixes/owning-results.json` failed on the original runtime and passed after the repairs with unchanged assertions. Final three-domain result: admin-health9/9, maintenance-settings7/7, maintenance15/15. PostgreSQL executed the scheduled SQL and transaction paths. The overlap case repeats concurrent operations three times; it is not a forced deadlock schedule. Source release/full deployment gates remain independently required.
