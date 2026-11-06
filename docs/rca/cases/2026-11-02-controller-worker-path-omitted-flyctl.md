---
id: 2026-11-02-controller-worker-path-omitted-flyctl
date: 2026-11-02
title: Isolated controller worker could not discover its installed Fly client
surface: infra
component: deploy-worker-provisioning
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the new isolated controller worker was accepted without verifying flyctl on its inherited execution PATH
symptoms:
  - Native operator preflight exited 78 before provider allocation
  - cloudbench-controller remained UNVERIFIED
tags:
  - deploy
  - flyctl
  - worker-provisioning
sources:
  - PR #1662
  - commit e99c91f55b9444f01a90bd4e8efc18315faeb51b
  - commit 6f3f53201faac3a3e70de099e7c211cee6770fad
  - task 0f9b5ea2b6df49e3bb33ccc2c6cc6ae0
repro: /var/tmp/pr1662-rca-cloudbench-0f9b5ea2/repro.py
status: open
---

## Problem

The native controller preflight failed in 1.126 seconds, before any provider
operation. The isolated worker had Fly CLI v0.4.115 installed under
/home/boxes/.fly/bin, but the non-login execution PATH did not include it.
The original aggregate is UNVERIFIED, native exit 78. Its source, command,
native output and hashes remain in the occurrence and investigator report.

## Diagnosis

Gate: INTRODUCED at the new worker preparation and binding boundary. Main
6f3f53201 and frozen e99c91f55 have identical controller gate and operator
preflight bytes. The new worker binding inherited a remote PATH without the
installed executable and had no case-level override. Both unchanged preflight
copies fail in the controlled missing-tool environment and pass when only a
link to the existing executable is added. The exact command and before/after
logs are in /var/tmp/pr1662-rca-cloudbench-0f9b5ea2/report.json.

A second narrow reproduction uses the real binding generator and worker
run_step. It proves that an outer slot.env PATH is insufficient when an explicit
remote recipe is present: the case's environment is the execution boundary.
That candidate recipe change was not applied. The full gate contract remains
unchanged. The deploy owner independently challenged the initial source-only
attribution and the report identifies the new preparation omission explicitly.
Archive search found a related missing-Fly-client image case, not this host
launcher PATH omission. No outage or exhausted credits were established.

## Solution

The authorized preparation task added /usr/local/bin/flyctl as a symlink to
the already installed /home/boxes/.fly/bin/flyctl. Native preflight with the
original inherited PATH then returned 0, with empty stdout and stderr. The
receipt is .context/preparation/controller-path-repair-result.json. No package,
credential, application source, gate recipe or provider resource was changed.
The next complete controller gate remains required; the narrow preflight is
not a gate pass. This record remains open until that result is available.

## Human feedback

The user requires completion of the deployment with real evidence and no
invented owner-release hold. The preparation repair was explicitly scoped to
this executable link. Freedom and protected configuration remain unchanged.

## Reusable lesson

Verify host tools in the exact remote non-login execution environment before
accepting a worker, and distinguish that preparation boundary from unchanged
application code.
