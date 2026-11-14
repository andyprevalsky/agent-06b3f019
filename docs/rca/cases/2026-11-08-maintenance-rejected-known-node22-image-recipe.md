---
id: 2026-11-08-maintenance-rejected-known-node22-image-recipe
date: 2026-11-08
title: Native image admission recognized only the previous Node 20 recipe
surface: harness
component: cloudbench-maintenance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: image_build and image_inputs accepted only IMAGE_RECIPE_V1 despite the new published Node 22 recipe
symptoms:
  - "ValueError: native maintenance: original image recipe/config receipt"
  - unknown image recipe inputs
tags:
  - cloudbench
  - maintenance
  - image-recipe
  - source-binding
sources:
  - commit 5809574d5e0323fb2f285ce34746f955acde7593
  - commit ea2cb002fdef0c6c598adb0fe36157abfed6955f
repro: python3 scripts/tests/cloudbench-maintenance-authority.test.py
status: fixed
---

## Problem

Read-only image_build admission rejected the actual published image ending in
digest 566037c7709a963dbd8fed0925e1d1a0f58fd82fb906064f1e29899d734e85d3.
Its immutable receipt records build source 5809574d, successful publication and
registry handoff. The retained read-only-admission log reports the exact recipe
error before any provider call. Source ea2cb002 is a descendant of the build.

## Diagnosis

Both image_build and image_inputs recognized only the historical Node 20 recipe
hash cfd577f370e9f22c1b4263853cecdc50372483e8ab573ad958ae45eac97522a3.
The actual Node 22.23.4 recipe is
 d8f238df1258345e9fa52146b7598c52e73c71d38b82eb0c20448ebfe04cf819.
A byte comparison against the preserved Dockerfile.v1 fixture shows exactly one
change: FROM node:20-bookworm becomes FROM node:22.23.4-bookworm. All COPY/RUN
commands and their tracked dependency closure are identical. The same actual
receipt fails with the original helper and passes with the repaired helper.

## Solution

Add the exact V2 recipe to a known-recipe-to-input-closure map alongside V1.
Keep V1's hash, fixture, closure and evidence unchanged. Resolve the closure
from the committed build recipe, compare every selected input tree between
build and current source, retain clean-input checks, and require the receipt's
claimed recipe hash to equal those actual committed recipe bytes. Unknown
recipes still fail even when build and current HEAD are equal. Configuration,
ancestor, immutable image and publication checks remain required.

The owning maintenance authority suite retains its original 31 tests and adds
two controls covering V2 admission, exact original build-source retention,
forged recipe hashes, committed/uncommitted dependency changes and unknown
recipes. The real receipt replay and test logs are recorded in
.context/cli-nov08-user-sync/image-recipe-rca-result.json. No provider call,
activation, rebuild, database operation or historical result rewrite is needed.
The failed November 7 image remains UNKNOWN; this does not qualify it.
Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The operational parent assignment required isolated scratch, an exact V2 recipe
closure, preserved V1 pins and negative controls, the original maintenance
suite, and no activation, rebuild or provider/DB/financial calls. These are task
constraints, not a new direct user quote about deployment policy.

## Reusable lesson

Version recipe admission with exact reviewed input closures, and compare a receipt's recipe claim to its committed build bytes before admitting a new published image.
