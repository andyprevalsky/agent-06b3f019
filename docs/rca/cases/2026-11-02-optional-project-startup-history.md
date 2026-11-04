---
id: 2026-11-02-optional-project-startup-history
date: 2026-11-02
title: Missing optional startup history crashes project listing
surface: back-end
component: project-defaults
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Reading an optional historical startup-script directory throws ENOENT on backend-only deployments.
symptoms:
  - Missing optional startup history crashes project listing
  - Reading an optional historical startup-script directory throws ENOENT on backend-only deployments.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4446942865
  - plan:/project/rose-speed-comparison-20261028/final-project-findings/v2/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

Reading an optional historical startup-script directory throws ENOENT on backend-only deployments.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Catch ENOENT only from directory enumeration. Preserve sorted shell contents and propagate other directory and file errors.

## Validation

Isolated original fails; candidate passes missing-directory and non-ENOENT controls. Integrated projects API owner passes.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
