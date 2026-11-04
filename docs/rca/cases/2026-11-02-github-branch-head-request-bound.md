---
id: 2026-11-02-github-branch-head-request-bound
date: 2026-11-02
title: GitHub branch-head request has no cancellation bound
surface: back-end
component: github-maintenance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: A stalled fetch or response body blocks the sequential repository watcher.
symptoms:
  - GitHub branch-head request has no cancellation bound
  - A stalled fetch or response body blocks the sequential repository watcher.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4446942894
  - plan:/project/rose-speed-comparison-20261028/final-project-findings/v2/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

A stalled fetch or response body blocks the sequential repository watcher.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Attach the same 10-second AbortSignal to the existing request; preserve headers, URL, SHA validation and null-on-failure behavior.

## Validation

Exact registered helper proves cancellation for headers and body plus successful SHA. Integrated github-agent-repo owner passes. No live GitHub call was needed by the regression.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
