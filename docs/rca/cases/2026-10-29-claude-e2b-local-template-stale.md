---
id: 2026-10-29-claude-e2b-local-template-stale
date: 2026-10-29
title: Local Claude E2B mapping selected a CLI below the model minimum
surface: infra
component: claude-e2b-template-selection
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Local E2B_CLAUDE_CODE_TEMPLATE_ID selected the old CLI 2.1.138 image
symptoms:
  - Claude CLI version 2.1.138
  - model requires version 2.1.280
  - claude-code E2B smoke failed
tags:
  - claude-code
  - e2b
  - template-version
sources:
  - PR #1634
repro: back-end/src/tests/blackbox/claude-code.blackbox.ts
status: fixed
---

## Problem

The real Claude E2B smoke selected a template containing CLI 2.1.138. The
provider rejected the requested model because it requires at least 2.1.280.
Original run 1793299390-145942-32137 preserves the failure.

## Diagnosis

The ignored local backend environment still selected the old template even
though the newer image was already built. Its provider build log and receipt
agree on template gby3w62h9jqa22lpl2su, build
fd61236e-5653-46a7-828f-7dff0f221617, CLI 2.1.305, two CPUs and 4096MB.
The receipt is .context/e2b-template-builds/claude-code-v21305-c2-m4.json.
This is related to the October 24 Codex image-version skew, but is not the
September OAuth-header version defect. No image rebuild or credential change
was needed.

## Solution

Select the already-built image for the local smoke and correct the ignored
local template mapping. The same real E2B smoke passed in 38.587 seconds, run
1793299520-196395-4868. The old failure remains recorded. Production template
activation remains a separate deployment step; this local success does not
prove production rollout.

## Human feedback

The user requested completing setup and deployment. No gate waiver applies to
this real E2B smoke.

## Reusable lesson

Verify the selected image ID and its actual CLI version against the model
minimum; a successful build alone does not update runtime template selection.
