---
id: 2026-07-16-flyctl-command-word-splits-an-inline-boot-script
date: 2026-07-16
title: "`flyctl machine --command` word-splits an inline base64 boot script, so the boot payload must be injected as a file"
surface: infra
component: cloudbench-fleet
classification: third-party-failure
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "flyctl machine update --command — the inline value is word-split, so a single base64 boot-script argument does not arrive intact"
symptoms:
  - boot-launch machine command fails when the script is passed inline as base64
  - "on-box boot never runs the intended script"
tags:
  - cloudbench
  - flyctl
  - fly-io
  - argument-quoting
  - boot-launch
sources:
  - memory:project_cloudbench_boot_launch
repro: none-recorded
status: fixed
---

## Problem

While building boot-launch (running the bench driver from the machine's own boot
command instead of over ssh), passing the boot script inline as a base64 blob to
`flyctl machine ... --command` did not work: flyctl WORD-SPLITS the inline command
value, so the single argument did not arrive intact and the box did not run the
intended script.

## Diagnosis

`--command` is not a shell string passed through verbatim; flyctl splits it into
argv words. Any single-argument payload that contains characters flyctl treats as
separators is therefore corrupted before the guest ever sees it. This is a
provider CLI contract that the harness assumed away — the harness expected
"command string in, command string out".

## Solution

Inject the script as a file and keep the command trivial:
`--file-local /cloudbench-boot.sh=scripts/cloudbench-boot.sh --command "bash /cloudbench-boot.sh"`.
This also removed the need for the boot script to live inside the warm Fly
snapshot (it now ships per run), which decoupled boot-script changes from
snapshot rebuilds — snapshots cannot be deleted on Fly, so that coupling had been
its own source of stuck runs.

## Human feedback

None recorded.

## Reusable lesson

Never smuggle a multi-word payload through a provider CLI's `--command` flag —
ship it as a file and make the command a one-word invocation of that file.
