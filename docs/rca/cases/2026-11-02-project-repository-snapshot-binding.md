---
id: 2026-11-02-project-repository-snapshot-binding
date: 2026-11-02
title: Repository changes retain old snapshot and sync payload bindings
surface: back-end
component: project-workspace
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Project repository changes leave reusable template and sync artifacts from the previous repository, and stale writers can cross the change.
symptoms:
  - Repository changes retain old snapshot and sync payload bindings
  - Project repository changes leave reusable template and sync artifacts from the previous repository, and stale writers can cross the change.
tags:
  - pr1634
  - final-review
sources:
  - PR #1634 https://github.com/Rose-Ai-Labs/rose/pull/1634#discussion_r4446942885
  - plan:/project/rose-speed-comparison-20261028/final-project-findings/
repro: Original and fixed commands, exact source hashes and raw evidence are retained in the source handoff.
status: fixed
---

## Problem

Project repository changes leave reusable template and sync artifacts from the previous repository, and stale writers can cross the change.

## Diagnosis

The final review on source `199d47f6c` exposed this boundary. Review suggestions were treated as untrusted leads and verified against the actual source. Original failures remain preserved.

## Solution

Preserve snapshot cleanup IDs and encrypted data while invalidating usable template metadata and watch state. Refuse repository edits during owned maintenance; fence maintenance starts by repository. Bind sync reuse to its manifest, preserve SSH aliases and local path identity, and commit revision plus sync writes atomically.

## Validation

Original isolated controls fail and fixed controls pass, including old artifacts and stale auto-bind. Independent review caught relative-path identity and stale payload retention; their originals are preserved. Integrated project-maintenance-settings, projects, project-workspace and project-maintenance owners pass. No native snapshot deletion was added.

The whole-release gates and production verification remain separate; this local fix record does not claim deployment.

## Human feedback

The user authorized fixing the issues and completing deployment. Preserve Freedom, native resource custody, credentials and original failures. No assertions or thresholds were weakened.

## Reusable lesson

Exercise the public caller and persisted identity boundary, preserve negative controls, and retain unknown measurements rather than guessing.
