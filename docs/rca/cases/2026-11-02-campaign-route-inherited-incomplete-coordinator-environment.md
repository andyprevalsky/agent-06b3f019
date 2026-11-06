---
id: 2026-11-02-campaign-route-inherited-incomplete-coordinator-environment
date: 2026-11-02
title: The new bounded smoke campaign inherited incomplete coordinator tool and interpreter paths
surface: infra
component: deploy-coordinator-preparation
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: shared relay parent could not resolve installed flyctl and Hub publisher could not load dotenv under system Python
symptoms:
  - FileNotFoundError: [Errno 2] No such file or directory: 'flyctl'
  - HubVisibilityError: benchmark Hub API key is missing
  - Campaign inventory did not initialize
tags:
  - smoke
  - campaign
  - executable-path
  - python-environment
sources:
  - PR #1662
  - commit e99c91f55b9444f01a90bd4e8efc18315faeb51b
  - commit e62978decdfffa17da358783556051440051d47a
  - commit 067495d51582f3946d5a5b980ccc8416b66dff02
  - task 8d6e31666e9847cb8add0896efeafe46
repro: /var/tmp/pr1662-smoke-round16-prerequisites/relay_repro.py and hub_repro.py
status: open
---

## Problem

Round16's 17-task bounded campaign recorded peak concurrency zero and cancelled
all jobs without starting one. The native inventory child completed a 9,574,500
byte snapshot before the parent shared relay failed to execute flyctl. The parent
startup catch labelled the relay exception as inventory initialization failure.
Starting and terminal Hub publication separately failed because their API key
was missing. All task outcomes remain UNVERIFIED and all original failures remain.

## Diagnosis

The frozen coordinator environment excluded the installed Fly client directory
and the canonical agents virtualenv. The staged checkout has no agents/venv;
run-bench therefore chose PATH python3, which was system Python without dotenv.
That caused the native optional dotenv import to skip loading the available
staged backend .env key. The inventory shell independently adds HOME/.fly/bin,
which explains its success without repairing the parent's executable lookup.

The exact shared-relay read-only flyctl status call failed with FileNotFoundError
under the captured environment and returned zero in 2.11 seconds after only the
Fly directory was added. The unchanged native publisher credential-loading AST
plus native _auth_headers failed with the recorded missing-key error under system
Python and succeeded using canonical venv Python. Values were never printed.
The exact run-bench interpreter selection confirmed both interpreter paths.
Native route files are byte-identical across main 6f3f53201, pre-repair e99c91f55
and frozen 067495d51. The deploying repair e62978dec newly activated the campaign
path without validating these coordinator prerequisites. Gate: INTRODUCED at this integration boundary was independently reviewed without
blocking objection; this is not a provider outage or exhausted-credit exception.

Archive searches used FileNotFoundError flyctl and campaign inventory did not
initialize. The controller-image and remote-worker PATH cases are relatives,
not evidence for this local coordinator occurrence. No prompt edit is proposed;
Golden reference: not applicable (no approval-gated hunk).

## Solution

Prepare a new frozen coordinator environment that prepends the existing canonical
agents virtualenv bin and Fly bin directories. Preserve the old private snapshot
and apply only at the parent's terminal boundary, with normal environment refresh.
No application source, provider cap, task, timeout, credential value or benchmark
assertion changes are necessary. This is preparation proof only: real task and
publication outcomes await the unchanged smoke rerun by the deploy owner.

## Human feedback

The user reserved source/deployment ownership to the parent, prohibited full gates
and competing deployments, and required Freedom preservation. The parent requested
read-only native prerequisite proofs and will apply the prepared environment only
after the current round terminates.

## Reusable lesson

Validate executable discovery and credential-loader dependencies in the exact coordinator environment before enabling a new native campaign route.
