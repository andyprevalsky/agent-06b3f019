---
id: 2026-07-26-missing-kernel-api-key-silently-degrades-to-screenshot-mode
date: 2026-07-26
title: Missing `KERNEL_API_KEY` on the Fly worker silently degraded the browser tool to screenshot-mode, so no recording was ever produced
surface: agents
component: browser-agent
classification: configuration-error
problem_class: observability-trace-capture-gap
first_bad_boundary: Fly worker navi-whisper-lux has no KERNEL_API_KEY secret, and the browser tool falls back to screenshot-mode without logging
symptoms:
  - browser session recording shows "not available" in the FE
  - browser chip stays in the "started" state and never resolves
tags:
  - browser-agent
  - kernel
  - fly-secrets
  - silent-fallback
  - recordings
sources:
  - memory:project_browser_recordings_kernel_key_missing
repro: none-recorded
status: open
---

## Problem

Browser session recordings surfaced as "not available" in the frontend, and the
associated browser chip stayed in a dangling "started" state that never resolved.
The Fly worker `navi-whisper-lux` had no `KERNEL_API_KEY` secret set.

## Diagnosis

Without `KERNEL_API_KEY`, the browser tool falls back to screenshot-mode, so no
recording artifact is ever produced. The fallback is silent: nothing logs loudly
at finalization, so the missing worker secret presents as a frontend or artifact
bug rather than as a worker configuration gap, and the failure is invisible until
somebody opens a recording. The deeper owned cause is the silent degradation —
a capability the product advertises in the UI can be absent at runtime with no
signal anywhere in the logs.

## Solution

Two-part fix: (1) set `KERNEL_API_KEY` on the Fly worker (requires user approval
per the env-var rule in CLAUDE.md → Production Env Vars), and (2) make browser
finalization fail loudly instead of silently degrading to screenshot-mode, so the
missing key is reported where it happens rather than discovered by a user opening
a recording. Triage order for the recurrence: check the Fly secret
(`flyctl secrets list -a navi-whisper-lux`) before touching any frontend code.

## Human feedback

The human's standing rule applied here: diagnose the root cause rather than the
surface error — the FE "not available" string is the symptom, the worker secret is
the cause — and writing production env vars requires explicit user approval.

## Reusable lesson

When a capability reports "not available" in the UI, check the worker's secret
list before the frontend — and never let a missing credential silently degrade to
a lesser mode without a loud log at finalization.
