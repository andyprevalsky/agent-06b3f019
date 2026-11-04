---
id: 2026-11-03-cli-agent-init-json-is-not-shell-quoting
date: 2026-11-03
title: Agent setup commands treated JSON quoting as shell quoting
surface: harness
component: rose-sync
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agentGuide or setupStatus inserts a project name or executable into a shell command
symptoms:
  - Printed commands expanded dollar substitutions and backticks or parsed executable paths incorrectly
  - Printed project argument changes after command substitution
tags:
  - pr1634
  - review-regression
sources:
  - PR #1634 review5748355636
  - plan:/project/rose-speed-comparison-20261028/nov3-final-review-fixes/python-cli/HANDOFF.md
repro: Existing Rose and CLI-login registered owner regressions
status: fixed
---

## Problem

Printed commands expanded dollar substitutions and backticks or parsed executable paths incorrectly.

## Diagnosis

JSON.stringify produces a JSON string, not a POSIX shell word. The suggested folder name was JSON quoted while executable and bound project IDs could be unquoted.

## Solution

Use one single-quote POSIX shell-word function for each concrete executable/project ID/name. Preserve instructional placeholders and all approval/security text.

## Human feedback

The user instructed completion of the deployment and correction of blocking issues. Preserve Freedom, credentials, cooldowns, leases and existing acceptance criteria.

## Validation

The same local shell test failed both executable variants before and passed both after. Each variant executes seven printed commands and checks exact argv for spaces, apostrophes, dollars, backticks, semicolon and newline; no remote command runs. Registered owner validation passed: Rose289/289; CLI-login9/9 and repo-onboarding passed in artifact1793691277-2805897-17819. Original failed fixture integration retained in1793691173-2766599-4969; exact quoted-ID expectations and Prisma delegate seam were corrected without weakening assertions. No production outcome is claimed.

## Reusable lesson

Validate the actual execution boundary and retain failure/cancellation semantics rather than testing only a formatting or helper function.
