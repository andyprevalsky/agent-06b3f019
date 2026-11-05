---
id: 2026-11-02-sidebar-persisted-speed-projection
date: 2026-11-02
title: Sidebar projection drops persisted agent speed
surface: back-end
component: agent-sidebar
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The shared database selection omits speed, so the serializer falls back to the legacy cache flag.
symptoms:
  - Sidebar projection drops persisted agent speed
  - The shared database selection omits speed, so the serializer falls back to the legacy cache flag.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4446942848
  - plan:/project/rose-speed-comparison-20261028/nov2-final-review-terminal-repair/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

The shared database selection omits speed, so the serializer falls back to the legacy cache flag.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Select persisted speed. Add a registered sidebar case for active, search and archive results across all three speeds, using contradictory legacy flags.

## Validation

The exact callback fails on original source and passes on candidate. Integrated agents owner passes. The unchanged new case is moved into its own explicitly imported module to respect the existing file-size lint limit.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
