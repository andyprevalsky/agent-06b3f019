---
id: 2026-10-15-native-installer-did-not-enforce-vendored-wheel-digest
date: 2026-10-15
title: Native installer did not enforce the vendored wheel digest
surface: infra
component: world-model-vendor-integrity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: setup-world-model.sh invoked uv before checking the wheel against SOURCES.txt
symptoms:
  - Corrupted vendored wheel can pass setup metadata validation
  - Missing SOURCES.txt does not prevent installer invocation
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-native-setup/result.private.json
repro: agents/benchmarks/world_model_vendor_test.py
status: open
---

## Problem

A private copy of the canonical wheel was corrupted while preserving its declared version. The actual original Bash owner still invoked the fake installer and returned healthy; its unit-only digest test did not protect runtime setup.

## Diagnosis

The requirements digest pins requirements text, not wheel bytes. Distribution-version checks cannot authenticate a wheel whose content changes without a version change. Integrity enforcement belonged before uv venv or pip, not only in a test.

## Solution

The runtime installer now parses exactly one canonical wheel/SOURCES record with shell builtins, validates a 64-character hexadecimal digest and verifies actual bytes using existing sha256sum or Mac-compatible shasum before any native-environment mutation. Missing/invalid metadata and mismatch fail closed even on cached/override paths. Canonical wheel SHA256 remains f15392b6c09676f1d9905be0afe5e2c3aa8222a1674cffefc94a00c2ddb2cf36; requirements and all original package bytes are unchanged. Shared installer controls went 2 FAIL / 2 PASS to 4 PASS; parent reported five actual vendor tests passing. No wheel rebuild, upstream download or operational model acceptance was inferred.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `04199d309ed0dda7347eea20b39f22b035c44dc80fd9e29fbac7e4f6c97f2513`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Authenticate vendored bytes before every installer mutation instead of relying on package version metadata or a test-only checksum.
