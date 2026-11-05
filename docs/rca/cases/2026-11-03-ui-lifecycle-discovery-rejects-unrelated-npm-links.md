---
id: 2026-11-03-ui-lifecycle-discovery-rejects-unrelated-npm-links
date: 2026-11-03
title: UI lifecycle discovery rejects unrelated external npm links
surface: front-end
component: ui-lifecycle-patches
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/scripts/patch-ui-lifecycle.mjs discoverInstalledPackages treats every scanned package as a required lifecycle target
symptoms:
  - UI dependency directory is outside the workspace
  - An unrelated npm link prevents install, dev, build and test guards
tags:
  - npm
  - symlink
  - lifecycle
sources:
  - PR #1670
  - commit 11c6e07269b47a3db1f6b096a8779453e109ce9d
repro: front-end/src/tests/blackbox/rendering-review-lifecycle.blackbox.tsx
status: fixed
---

## Problem

The required lifecycle guard rejects a legitimate workspace containing an unrelated unscoped or scoped npm link outside its root. Actual installed target packages remain inside the workspace. The same exception prevents every entrypoint guarded by the repair runner.

The actual filesystem regression invokes the production runner with real temporary package directories and symlinks. It fails before any target patch with the exact outside-workspace exception. Both unrelated-link cases fail; known target escapes remain correctly rejected.

## Diagnosis

Path: workspace roots → Node module lookup roots → directory traversal → target resolution → full source validation → patch application.

The first bad boundary is generic package traversal calling the same strict resolver used for known targets. Resolving an unrelated npm link throws before the runner can validate its actual supported targets. No dependency source, manifest version or patch transform is responsible.

Searches used literal outside-workspace/npm-link terms and dependency lifecycle discovery terms. The npm-ls-prunes-workspace case is a relative about incorrect install readiness, not this directory traversal boundary.

## Solution

Skip external generic package/scoped entries during traversal. Keep module lookup roots and named lifecycle target resolution strict. Validate every supported target before any mutation.

A rejected private draft also softened module lookup-root validation. An adversarial real Node resolver fixture proved that a frontend node_modules link could then resolve an external pristine SDK while the guard patched a valid root fallback and reported success. Strict lookup-root validation is retained. The same control asserts both foreign and local files remain pristine on rejection.

The permanent seven-test normal regression retains all four filesystem cases, direct current-source imports, original exception checks and second-run idempotence. On the original merged 7e51f7e9 modules, the suite reports four failures and three positive passes. The identical final formatted regression also reproduces four failures and three passes against byte-exact original modules in an ignored isolated import copy. The actual repaired production modules pass all seven cases on five consecutive unchanged normal runs using `npx vitest run src/tests/blackbox/rendering-review-lifecycle.blackbox.tsx` in front-end. Eight related rendering and lifecycle suites pass all 60 tests. Focused ESLint, formatting, Node syntax, combined full frontend typecheck and the installed ten-entry lifecycle guard pass. Full release gates and production verification remain pending; local causal proof does not establish rollout.

At large scale this scans package directories once and never scans dependency source files; no per-message or animation-frame work is added.

## Human feedback

Preserve all features and dependency safety boundaries. Do not bypass the guard, ignore a required target escape or weaken version/source validation to accept unrelated links.

## Reusable lesson

Discovery of unrelated entries and validation of the runtime packages actually used by the app require different failure policies. A local fallback cannot establish that an escaping frontend resolution is repaired.
