---
id: 2026-10-05-detached-wait-fixture-scanned-earlier-monitor-receipts
date: 2026-10-05
title: Detached waiter fixture mistook an earlier terminal monitor receipt for a leak
surface: harness
component: cloudbench-controller-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The waited-run cleanup assertion scanned status receipts belonging to every earlier fleet
symptoms:
  - detached wait fleet left a consumed status rendezvous
  - detached fleet completed (exit=0)
  - only the earlier no-wait terminal status remained
tags:
  - cloudbench
  - controller
  - detached
  - ownership
  - regression
sources:
  - commit eb0a41fe1bfa68547594cf1c57a399a0522028a5
  - task canonical cloudbench-multi-workstream deployment gate
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

The complete controller fixture first ran an ordinary detached fleet, then a
second detached fleet with `--wait`. Both completed successfully and cleaned
their exact machines, volumes, ownership records and script snapshots. The
waiter assertion nevertheless failed because it searched the entire runs
directory for any `detached-*.status` file.

## Diagnosis

An unchanged owning reproduction failed in 78.522 seconds. Keeping its existing
temporary fixture allowed examination of both launcher-printed status paths:
the earlier no-wait receipt existed with value `0`, while the current waited
receipt was absent and its launcher reported exact completion status `0`.
The only remaining status file belonged to the earlier fleet. Private original
logs and a receipt containing these exact file states remain in the deploy run.

The no-wait receipt is intentional terminal evidence for subsequent monitor
polls. The waiter consumes only its own rendezvous after its tracked process
group drains. Removing an older receipt would break that monitor contract.
Archive searches for consumed status, status rendezvous, terminal monitor,
no-wait and durable status found no prior matching fixture case.

## Solution

Resolve each exact status marker from its own launcher output and verify its
identity against that launcher's detached log. Require the waited marker to be
absent, and require the earlier no-wait marker to contain `0` both before and
after the second fleet. Existing provider, ownership and snapshot cleanup
assertions remain unchanged. No production cleanup or terminal receipt changes
are needed. The original failed full run remains failed; final complete owning
verification is required before deployment.

## Human feedback

Check terminal monitor ownership before changing cleanup assertions. Preserve
older durable receipts and use the current launcher's exact rendezvous path.

## Reusable lesson

A cleanup assertion must identify the resource owned by its run. A shared runs
directory can contain valid evidence from earlier completed runs.
