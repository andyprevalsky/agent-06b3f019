---
id: 2026-10-29-publication-retirement-probes-raced-native-reaping
date: 2026-10-29
title: Publication retirement observer rejected a process reaped between native probes
surface: harness
component: cloudbench-campaign-publication-retirement-test
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _assert_publication_process_retired assumes successful kill and ps imply the subsequent process birth read must still succeed
symptoms:
  - publication birth changed or unreadable for 3762211
  - test_campaign_inventory_group_publication_cancellation_retires_only_its_owned_processes[final]
  - process-identity returned 1 with empty output after successful ps
  - unknown publication state
sources:
  - commit c06bb89f429cef558363de76f086842b06121d6c
  - PR #1627
  - plan:/var/tmp/deploy-1627/c06-publication-observation-rca/report.md
tags:
  - process-identity
  - native-observation
  - reaping-race
  - cloudbench
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py test_campaign_inventory_publication_retirement_rechecks_reaped_process
status: open
---

## Problem

Current c06 structural benchmark-live-results shard2 failed one final-publication
cancellation case. Original shard: 1 failed,187 passed,1 skipped,2177 deselected
in101.29 seconds. The owning helper observed kill(0) and ps success, followed by
an empty failed birth-identity read. Original historical absence was not recorded.

## Diagnosis

A real child deliberately reaped between ps and the native process-identity
invocation gives the same assertion and empty exit1. Reaping between kill(0) and
ps fails its sibling assertion. The sequential observer makes retirement itself
a possible failure. This proves a sufficient causal boundary, not the unrecorded
historical process state. Prior immutable birth-token RCA was read; the existing
/proc identity is appropriate and not changed.

## Solution

TEMP candidate adds one kill(0) recheck after each failed/empty observation and
accepts only ProcessLookupError. Unknown observations for a live process still
fail. Changed birth still fails. All existing assertions and tests are unchanged;
seven regression cases add real-reaping and live/permission-denied controls.
Same eleven-case subset fails2/passes9 before, passes11 five times after.
Evidence lives under /var/tmp/deploy-1627/c06-publication-observation-rca.
Parent owns independent review, application, archive indexing and full-gate rerun.
This case remains OPEN until those steps finish; historical absence remains UNKNOWN.
No provider call, source edit, timeout or ownership contract change was made.

## Human feedback

Parent required both observation races, same/changed live birth, real zombie,
permission-denied and unknown-observation controls, unchanged budgets/assertions,
and an explicit UNKNOWN for historical absence. Source and full-gate ownership
remain with the parent.

## Reusable lesson

Recheck confirmed native absence after an observation fails before treating a disappearing process as an ownership violation.
