---
id: 2026-07-24-linux-hydration-rejected-darwin-only-mac-dependency
date: 2026-07-24
title: Auto-RCA's Linux runner rejected a Darwin-only mac dependency before JavaScript tests could run
surface: infra
component: auto-rca
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Auto-RCA dependency hydration — ordinary npm platform checks treated node-mac-contacts as a Linux runtime dependency
symptoms:
  - Auto-RCA installs 1887 packages then fails environment setup
  - node-mac-contacts declares Darwin-only support on a Linux Actions runner
  - mac-app JavaScript structural and blackbox tests never start
tags:
  - auto-rca
  - github-actions
  - linux
  - mac-app
  - dependency-hydration
sources:
  - PR #887
repro: scripts/tests/auto-rca-workflow.test.sh
status: fixed
---

## Problem

Production run 30069607352 hydrated the root and workspace packages, then npm
correctly rejected `node-mac-contacts` because the Auto-RCA runner was Linux and
the package declares Darwin-only support. This blocked JavaScript-only mac-app
tests that do not execute native macOS code.

## Diagnosis

The test hydration path reused normal runtime platform enforcement even though
its purpose was only to make the mac-app JavaScript import graph available.
Native modules were neither built nor executed, but npm rejected the dependency
before the relevant structural and blackbox tests could load.

## Solution

Hydrate the mac-app JavaScript test graph with npm's platform override and
lifecycle scripts disabled. Native macOS binaries remain unbuilt and unexecuted
on Linux while test imports are available.

## Human feedback

None recorded.

## Reusable lesson

Separate cross-platform JavaScript test hydration from native runtime
installation, and disable native lifecycle execution on the foreign runner.
