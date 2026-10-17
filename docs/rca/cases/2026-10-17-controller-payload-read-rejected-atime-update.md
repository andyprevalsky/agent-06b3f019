---
id: 2026-10-17-controller-payload-read-rejected-atime-update
date: 2026-10-17
title: Controller payload verification rejected its own access-time update
surface: infra
component: cloudbench-controller-launch-payload
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the launch payload verifier compared entire before and after stat records around a read
symptoms:
  - test_large_launch_payload_uses_a_small_hash_bound_file_command
  - test_launch_payload_verification_allows_read_access_time_update
tags:
  - cloudbench
  - startup
  - filesystem
sources:
  - commit 5a05e6590099f9cdf97f980574a5db99ff2f4289
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: python3 scripts/tests/original600-portable-operator.test.py Portable.test_launch_payload_verification_allows_read_access_time_update
status: fixed
---

## Problem

Combined operator verification intermittently failed in the exact gate's payload
file verifier at its before/after stat comparison. Isolated reruns of that test
passed, and the original failure did not retain the differing stat field.
A separate controlled reproduction gave a valid payload an old access time and
ran the same verifier. The read updated atime and the verifier rejected otherwise
unchanged bytes. This reproduction establishes the access-time defect without
claiming it caused a recorded native startup failure.

## Diagnosis

The verifier used whole-stat equality around a read. Access time is metadata
that the read itself may legitimately change. Archive searches for `atime` and
`access.time` found no existing case for this boundary. The permanent control
executes the actual embedded verifier, preserving the original private-file,
length and SHA checks. It fails before the fix and passes after it.

## Solution

Compare device, inode, mode, owner, group, link count, size, modification time and
change time. Exclude access time. The same descriptor must still contain exactly
the expected bytes and SHA; physical-path, regular-file, private-mode and
single-link checks remain. Existing wrong-hash and symlink controls are retained.
No timeout, payload size, task criterion or provider operation changes.

## Human feedback

None recorded for this boundary. The broader startup simplification retains the
user's original task count, concurrency and deadlines.

## Reusable lesson

A read-stability check must distinguish content and identity metadata from
metadata that the read itself updates.
