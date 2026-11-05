---
id: 2026-11-03-maintenance-takeover-orphaned-running-row
date: 2026-11-03
title: Expired maintenance takeover leaves the previous run RUNNING
surface: back-end
component: project-maintenance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: claimRun overwrites the project lease pointer without terminalizing predecessor run rows
symptoms:
  - winning takeover terminalizes old running row
  - predecessor terminal
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

Expired maintenance takeover leaves the previous run RUNNING. The review identified the boundary on the frozen PR1634 source.
No corresponding maintenance module exists on compared main713f9cbf; this is
an introduced feature defect, not evidence of an external outage.

## Diagnosis

claimRun overwrites the project lease pointer without terminalizing predecessor run rows. The private harness executes actual transpiled maintenanceStore
functions and the extracted actual maintenanceData function. Original source
passes the losing-CAS control and fails the other five controls; candidate
passes all six. The SQL fake models eligibility before LIMIT but does not
establish PostgreSQL parsing, real transaction isolation or schema correctness.
Exact commands and raw logs are retained in nov3-review-fixes/maintenance.

Archive searches: expired maintenance RUNNING orphan; claim lease superseded history. Six total searches retained in archive-searches.log.
Related maintenance-clean-template and custody cases have different first-bad
boundaries; no exact recurrence established.

## Solution

After successful lease CAS, mark other RUNNING rows for the same project failed within the same transaction. Losers roll back and cannot affect predecessors. Existing publication and late-completion fences preserve successor custody.
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

Complete predecessor bookkeeping in the same transaction that transfers the ownership pointer.

## Integrated verification

The exact normal owning command in `nov3-review-fixes/owning-results.json` failed on the original runtime and passed after the repairs with unchanged assertions. Final three-domain result: admin-health9/9, maintenance-settings7/7, maintenance15/15. PostgreSQL executed the scheduled SQL and transaction paths. The overlap case repeats concurrent operations three times; it is not a forced deadlock schedule. Source release/full deployment gates remain independently required.
