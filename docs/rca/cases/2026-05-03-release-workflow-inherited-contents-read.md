---
id: 2026-05-03-release-workflow-inherited-contents-read
date: 2026-05-03
title: mac-app release workflow inherited `contents: read`, so creating the GitHub Release 403'd
surface: infra
component: mac-app-release-workflow
classification: configuration-error
problem_class: other
first_bad_boundary: ".github/workflows/release-mac-app.yml — no `permissions:` block, so the job inherited the repo default `contents: read`"
symptoms:
  - "softprops/action-gh-release fails with 403 when creating the GitHub Release"
  - notarization, code-signing and Supabase artifact upload all succeed but no GH Release entry appears
  - mac-app release looks green until the very last step
tags:
  - github-actions
  - mac-app
  - release
  - permissions
  - http-403
sources:
  - PR #559
repro: none-recorded
status: fixed
---

## Problem

On the v1.1.42 mac-app release, every step before the GitHub Release upload was
green — build, code-signing, notarization, and the Supabase artifact upload all
succeeded — and only `softprops/action-gh-release` failed, with a 403 while
creating the Release entry. The net effect was artifacts published to Supabase
with no corresponding GitHub Release.

## Diagnosis

`release-mac-app.yml` declared no `permissions:` block, so the job inherited the
repository default of `contents: read`. Creating a GitHub Release is a write to
repository contents, so the action's API call was rejected with 403. The failure
landed at the end of an otherwise fully successful pipeline, which is exactly the
shape that reads as a flaky upload rather than as a missing grant: the token was
valid, the artifacts were valid, only the scope was insufficient.

## Solution

Added `permissions: contents: write` to `release-mac-app.yml`. This is a
one-line YAML change with no runtime impact — workflow YAML is in the
"safe to skip smoke" set — and it fixes every subsequent release, since the same
inherited-default problem would recur on every run rather than intermittently.

## Human feedback

None recorded.

## Reusable lesson

A 403 from a GitHub Action on the last step of an otherwise-green workflow is
almost always an inherited default `permissions:` scope, not a credential or
artifact problem — check the workflow's `permissions:` block before suspecting the
token.
