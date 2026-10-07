---
id: 2026-10-06-nested-canary-positive-release-omitted-membership
date: 2026-10-06
title: Nested canary positive fixture omitted exact release membership
surface: harness
component: fleet-infra-canary-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: fleet-infra-canary.test.sh valid-parent release.json omitted the jobs/PID membership required by the actual campaign barrier helper
symptoms:
  - nested canary consumed its parent's campaign rendezvous
  - valid parent rendezvous returned nonzero
  - host controller runtime gate exited 1
tags:
  - fixture
  - campaign
  - release-membership
  - nested-canary
sources:
  - PR #1424
  - commit 7872fa3d78d7ba38d2556d5b354fe0fc0400ee95
repro: bash scripts/tests/fleet-infra-canary.test.sh
status: open
---

## Problem

The ordinary host controller continuation failed after 37.301 seconds. Its
canary fixture diagnostic suggested the nested controller consumed its parent
slot. The actual traceback maps to the final positive valid-parent rendezvous
assertion; the earlier inherited identity, foreign PID and no-ready-publication
assertions had already succeeded.

## Diagnosis

The fixture wrote a release containing only cohort_id. The reviewed survivor
release protocol also requires exact jobs/PID membership, and the actual helper
checks that membership before consuming release. The intended valid fixture
therefore supplied malformed stage-handoff data. Weakening the helper would
undo the required excluded-member and wrong-controller protections.

Two archive searches used nested canary/campaign rendezvous and exact release
membership. The strict cohort and survivor cases are related runtime protocols,
with different owning causes. Their custody and member rejection controls stay
correct. This case concerns an independently implemented positive fixture that
was not updated with the stronger release schema.

## Solution

Add the existing parent-job/current-PID binding to that positive release JSON.
Keep every inherited-environment, nested-lock, distinct owner token, foreign PID,
missing-ready and valid-parent assertion. The same complete canary family passes
in 2.180 seconds against the current byte-bound production helper and sources.
No production code, task/overall bound, extra gate, provider or model call is
changed. The existing host controller and structural routes already invoke the
family. The original failed owner/output and native candidate receipt remain
private and separate. Final normal continuation on the composed source is still
required, so this case remains open until that qualification.

## Human feedback

Keep stage handoff and exact resource ownership usable, avoid speculative timer
changes, and retain honest original failures. No additional approval is needed.

## Reusable lesson

A positive protocol fixture must publish the complete consumer-owned schema;
keep the consumer's ownership rejection intact.
