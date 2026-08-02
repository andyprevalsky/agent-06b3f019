---
id: 2026-07-20-kernel-api-key-missing-on-fly-worker
date: 2026-07-20
title: KERNEL_API_KEY was unset on the Fly worker, so prod browser recordings pointed at dead /tmp screenshot paths
surface: infra
component: fly-worker
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Fly worker secrets — KERNEL_API_KEY absent, so the recorder silently used local screenshot paths instead of Kernel hosted replay
symptoms:
  - prod browser recordings resolve to dead /tmp screenshot paths
  - no Kernel hosted replay available for a prod browser agent run
tags:
  - kernel
  - fly
  - env-vars
  - browser-recording
  - observability
sources:
  - PR #816
repro: none-recorded
status: fixed
---

## Problem

While root-causing prod agent `53feac08`, the browser-agent recordings for the run
were unusable: they referenced `/tmp` screenshot paths that do not survive on the
prod worker, so there was no replay to inspect for a failing browser task.

## Diagnosis

`KERNEL_API_KEY` was never set on the Fly worker. Without it the recorder fell back
to writing local screenshot files rather than producing Kernel hosted replay, and it
did so silently — the run appeared to have recordings, they simply pointed at paths
that no longer exist by the time anyone reads them. The deeper problem is a
capability that degrades quietly on a missing credential: the loss is invisible until
someone needs the recording to diagnose an incident, which is precisely when it is
too late.

## Solution

Set `KERNEL_API_KEY` on the Fly worker (applied as infrastructure alongside the
browser-path code fixes in PR #816), so prod browser recordings use Kernel hosted
replay. This restores the evidence trail that a browser-agent RCA depends on.

## Human feedback

None recorded.

## Reusable lesson

A missing credential that silently downgrades a capability is an observability
outage — when recordings or traces point at ephemeral local paths in prod, check for
an unset provider key on the worker.
