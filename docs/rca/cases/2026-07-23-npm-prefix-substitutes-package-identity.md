---
id: 2026-07-23-npm-prefix-substitutes-package-identity
date: 2026-07-23
title: Running the frontend lock probe with npm 11 `--prefix` substituted package identity and failed the semantic deploy gate
surface: harness
component: deploy-pipeline
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: semantic lock probe invocation — used `--prefix` instead of running from the fixture directory, so npm 11 resolved a different package identity
symptoms:
  - "Missing: semantic-lock.<random>@0.0.0"
  - exact semantic deploy gate fails on the standalone frontend lock probe
tags:
  - deploy-gate
  - npm
  - lockfile
  - working-directory
  - semantic-gate
sources:
  - PR #874
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

The exact semantic deploy gate failed on the standalone frontend lock probe with
`Missing: semantic-lock.<random>@0.0.0`. Post-fix, the identical command passes.

## Diagnosis

The probe was invoked with npm's `--prefix` rather than being run from its fixture
directory. Under npm 11, `--prefix` does not reproduce GitHub Actions'
`working-directory` semantics: it substitutes package identity, so the dry-run install
looked for the probe's own generated package name (`semantic-lock.<random>@0.0.0`) and
reported it missing. The probe's assertions and copied manifests were all correct — the
invocation put npm in a directory context where the package under test was not the
package npm believed it was resolving.

## Solution

Run the standalone frontend lock probe from its fixture directory, matching GitHub
Actions' `working-directory` semantics and avoiding npm 11's `--prefix` package-identity
substitution. The copied manifests, dry-run install, and every existing assertion are
preserved. Proven by the exact gate command failing pre-fix and passing post-fix, with
an independent adversarial RCA review returning APPROVE; deploy structural gates passed
11/11.

## Human feedback

An independent adversarial RCA review was required and returned APPROVE, and the RCA had
to show the exact pre-fix failure and the identical post-fix pass rather than an
argument that the change was correct.

## Reusable lesson

Reproduce CI's `working-directory` by actually changing directory — npm `--prefix` is not
equivalent and can silently substitute the package identity being resolved.
