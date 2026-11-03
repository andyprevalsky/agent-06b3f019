---
id: 2026-11-03-native-cloud-reconciliation-missed-campaign-recovery
date: 2026-11-03
title: Native cleanup reconciliation rejected campaign membership and recovered release evidence
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: single-fleet reconciliation required one detached controller and original lifecycle audit seal after native recovery produced a separate release seal
symptoms:
  - "native cleanup proof refused"
  - "controller_log"
  - "native audit seal"
tags:
  - deploy
  - campaign
  - cleanup
  - ownership
  - evidence
sources:
  - PR #1662
  - commit 3625eccd4952388c56e979c6a61045dff1c7804a
repro: python3 scripts/tests/deploy-test-cycle.test.py -q
status: open
---

## Problem

The cloud adapter routes smoke checks through the existing single-task campaign.
The native cleanup reconciler still expected one detached controller whose first
fleet contained every requested check. The failed full run instead owned fourteen
single-task parent fleets and one nested infrastructure canary. Its original
coordinator and adapter receipts correctly retained fourteen UNVERIFIED results.

Canonical recovery later released eight exact owners, preserving each original
failed lifecycle and its missing-runtime flags. Recovery wrote new native audit
seals, provider release epochs and captured runtime evidence. The old reconciler
could not represent that producer layout or distinguish the new release evidence
from the immutable historical failure projection. Six other owners remain blocked.

## Diagnosis

This is a branch-introduced reconciliation contract mismatch, not a change to the
benchmark outcomes. A single-fleet controller-handle proof cannot stand in for a
campaign's exact parent/canary closure. Replacing an original lifecycle seal or
missing-runtime flag would fabricate historical cleanup success.

Independent review of the first private candidate found missing shared campaign
cleanup and publication checks. Later review found missing native root-custody
checks, including the requirement that the allocated primary root is graded.
Each finding was reproduced by an atomic refusal control before correction.

## Solution

Add an explicit campaign proof layout while preserving the existing single-fleet
contract. Bind the original receipt, adapter, full owner, source, token and native
campaign root. Require the exact terminal job inventory, each job's first parent
handle, all owned participants, and existing shared transport, ticket, inventory,
cohort, publication acknowledgment and publisher-quiescence checks.

For a canonically recovered parent, verify the new native provider audit seals,
release epoch, retired registry, resource dispositions, captured runtime manifest
and every original file hash. Bind the exact guest acknowledgment and native V2
stack identity. Parse every allocated root's native custody, deleted/sealed tree,
complete provider-session release receipts and terminal payment snapshot using
the existing payment predicate. Keep retained Hub identities and transfer duties.

The overlay only permits a future launch when every participant is proved. It
never edits original receipts, lifecycle files, missing-runtime flags, results or
financial records, and grants no task or cleanup PASS. All eight actually released
owners pass the bounded saved-evidence replay. The whole actual campaign still
refuses the six unresolved owners; no canonical reconciliation has occurred.

The final reviewed replacement has SHA256
4fe031bf1e459372e0496e91fb11ff058ec952ff22c604d025ac3ba9f7ce931f.
Registered owning controls cover campaign membership, shared pending obligations,
publication, source/owner changes, incomplete capture, custody, provider release
and payment refusal. The parent ran the owning cycle suite after integration: 87 tests passed.
Native coverage and actual whole-campaign cleanup remain open.

## Human feedback

Keep deployment moving autonomously while preserving real failures and exact
owned resources. Infrastructure fixes do not authorize fabricated results,
financial settlement, evidence reconstruction or cleanup exceptions.

## Reusable lesson

A recovery producer may emit a new release record while preserving its original
failed execution projection. Validate the new record against exact membership and
all native cleanup authorities; never rewrite the old failure to make it fit.
