---
id: 2026-07-24-claude-action-native-path-produced-zero-turn-success
date: 2026-07-24
title: Auto-RCA's Claude Action path returned success with zero model turns and no reproduction
surface: infra
component: auto-rca
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Claude Code Action executable setup — the native executable path was not restored before invoking the investigator
symptoms:
  - Auto-RCA investigator reports success with num_turns 0
  - investigator duration is under 30 milliseconds
  - the workflow advances with no reproduction artifact
  - a skipped issue-comment run replaces the real workflow link
tags:
  - auto-rca
  - claude-code
  - github-actions
  - zero-turn
  - false-green
sources:
  - PR #878
repro: scripts/tests/auto-rca-lifecycle.blackbox.test.sh
status: fixed
---

## Problem

Production agent `aa32b7e6-2153-4e37-8836-94cb30d86aab` produced two
apparently successful investigator steps with `num_turns: 0`, sub-30ms
durations, and no reproduction artifact. A later skipped comment workflow also
overwrote the useful run link.

## Diagnosis

The workflow did not restore the Claude Action's native executable path, and its
success contract accepted an action envelope without proving that Claude ran a
single useful turn. Transport success was mistaken for investigation success.

## Solution

Restore the native executable path, reject zero-turn results before reproduction
or deploy, ignore skipped/cancelled bot-comment runs during reconciliation, and
preserve previously resolved affected-user metadata.

## Human feedback

None recorded.

## Reusable lesson

Treat zero model turns as investigator failure regardless of the action
envelope's success status, duration, or exit code.
