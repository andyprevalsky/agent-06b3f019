---
id: 2026-11-02-shell-empty-deployment-array
date: 2026-11-02
title: Empty deployment arrays fail with Bash nounset
surface: harness
component: codex-funding-preflight
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: A configured endpoint with an empty deployment list expands an unset array under Bash 3.2 nounset.
symptoms:
  - Empty deployment arrays fail with Bash nounset
  - A configured endpoint with an empty deployment list expands an unset array under Bash 3.2 nounset.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4446942808
  - plan:/project/rose-speed-comparison-20261028/nov2-final-review-llm-rca/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

A configured endpoint with an empty deployment list expands an unset array under Bash 3.2 nounset.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Use the existing guarded array expansion in both blackbox and coverage runners. Preserve exact deployment checks and all original cases.

## Validation

The full five-case shell owner passes on installed Bash 5.2, including empty first slot and funded later slot. Bash 3.2 is unavailable locally; its native execution remains unverified.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
