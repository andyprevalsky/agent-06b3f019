---
id: 2026-11-07-supervisor-flagged-a-finishing-child-as-an-orphan-and-made-a-passing-gate-unrecoverable
date: 2026-11-07
title: The suite supervisor counted a child that was still exiting when the suite finished as an orphan, turning a passing structural gate into an unrecoverable UNVERIFIED receipt
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_supervisor.py (and its twin scripts/cloudbench-local-supervisor.py) set orphaned_children the instant the suite exited with any live child, with no observation window, so a fixture still winding down made lingering_group true
symptoms:
  - "deploy-command-structural focused rerun: worker status PASS, native exit 0, reason 'worker exit and test results disagree', lingering_group true, one orphan TERM-signalled"
  - "cloudbench-controller autoscale step: native exit 0, orphaned_children true, gate UNVERIFIED (first staged cycle on this branch)"
  - the staged cycle could not relaunch the gate: structural_cleanup reconciles only a failed (exit 1) structural receipt
tags:
  - supervisor
  - orphaned-children
  - staged-cycle
sources:
  - PR #1744
repro: scripts/tests/deploy-test-worker.test.py SupervisorOrphanSettle (a grandchild that exits after 0.4 s is not an orphan; one that lives 30 s still is and is TERM-signalled, for both supervisors); red on the old code ((78, 0, True, True) vs (0, 0, False, True)), green five times after. A traced local run of the structural runner under a subreaper reaped 308 orphaned children before exit and left none alive.
status: fixed
---

## Problem

A structural gate whose every suite passed was recorded UNVERIFIED because the supervisor found one live child at the instant the suite
exited, and that receipt (exit 0 with a lingering group) has no supported recovery, so the cycle had to be abandoned. The same detector flagged
the cloudbench-controller autoscale step in an earlier cycle. Gate: NOT_INTRODUCED for the changed product code; the detector is the defect.

## Diagnosis

The structural runner leaves hundreds of short-lived fixture processes that are reparented to the supervisor and exit on their own (308 reaped
before exit in a traced run). Whether one is still alive at the instant the runner returns is a scheduling race that grows with host load, so the
gate passed or failed on that race. The supervisor recorded the first live child as an orphan with no chance to finish.

## Solution

After the suite exits the supervisor observes its remaining children for up to one second without signalling them; a child that exits by itself
in that window is not a leak. A child still alive afterwards is flagged and signalled exactly as before, and cancellation and timeout paths keep
their immediate drain. Both supervisors carry the change and the regression covers both.

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

A leak detector needs a short settle window: "a process exists at the instant of exit" is not "a process was left behind".
