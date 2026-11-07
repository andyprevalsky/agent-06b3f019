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
  - "Campaign inventory did not initialize; see private publisher log (FileNotFoundError: [Errno 2] No such file or directory: 'flyctl')"
  - all jobs cancelled before starting, peak_concurrency 0, shared_inventory_failed true
tags:
  - smoke
  - campaign
  - executable-path
  - flyctl
  - run-bench
  - recurrence
  - python-environment
sources:
  - PR #1662
  - commit e99c91f55b9444f01a90bd4e8efc18315faeb51b
  - commit e62978decdfffa17da358783556051440051d47a
  - commit 067495d51582f3946d5a5b980ccc8416b66dff02
  - task 8d6e31666e9847cb8add0896efeafe46
  - commit b0fbd7742d (campaign parent shared relay gained bare flyctl calls)
  - fleet run campaign-20261107-225348-1436886 (descend-failed-neverrun-20261106 I-30 recurrence)
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py::test_campaign_inventory_normal_cli_resolves_home_fly_client_for_shared_relay (flyctl half); hub half /var/tmp/pr1662-smoke-round16-prerequisites/hub_repro.py
status: open
---

## Problem

Round16's 17-task bounded campaign recorded peak concurrency zero and cancelled
all jobs without starting one. The native inventory child completed a 9,574,500
byte snapshot before the parent shared relay failed to execute flyctl. The parent
startup catch labelled the relay exception as inventory initialization failure.
Starting and terminal Hub publication separately failed because their API key
was missing. All task outcomes remain UNVERIFIED and all original failures remain.

Recurrence 2026-11-07 (descend I-30): an ordinary `scripts/run-bench <3 tasks>
-k 3 --concurrency 9 --durable` launched from a shell without ~/.fly/bin
ended in 46.2 s with all 9 jobs cancelled and nothing allocated. The inventory
publisher completed a 7,885,125 byte machines snapshot and printed its ready
line; the next launch-log line was "Campaign inventory did not initialize; see
private publisher log (FileNotFoundError: [Errno 2] No such file or directory:
'flyctl')". The relay temp directory was created and left empty, so the first
relay `flyctl status` exec failed. The same command with a PATH prefix started.

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

Recurrence diagnosis: the 2026-11-02 repair prepared one coordinator environment
and left the CLI unchanged, so the next ordinary shell hit the same exec. At
268e9550b0, scripts/run-bench, the one supported entrypoint, added the documented
~/.fly/bin discovery only inside its full and sharded branches; the ordinary
campaign exec handed run-bench-campaign.py the caller's PATH. That parent's
_start_shared_relay execs bare `flyctl status` and `flyctl proxy` (added in
b0fbd7742d) with os.environ copies. Its inventory and fleet children survive
because each shell copies the same discovery. Deepest owned cause: discovery was
copied per route instead of owned once before route dispatch, so a new
parent-side consumer had none. The next rung, the host installer not putting
flyctl on the default PATH, is host configuration we do not own. Gate:
NOT_INTRODUCED by the descend run; the campaign bytes it used are base 268e9550b0.
The checked-in regression runs the real run-bench ordinary campaign route with
no flyctl on PATH and a fake client in HOME/.fly/bin. The exec'd campaign runs
the real start_shared_relay. Pre-fix it recorded the exact FileNotFoundError and
made zero client calls. Post-fix the unchanged test records both relay calls at
HOME/.fly/bin/flyctl; nothing contacts Fly.

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

Code fix for the flyctl half (rca/i-30-20261107): scripts/run-bench now runs the
existing discovery once, after maintenance dispatch and before every cloud route.
The full and sharded copies are deleted. The campaign parent, its shared relay,
and every inheriting child then resolve HOME/.fly/bin/flyctl with no shell patch.
An existing PATH flyctl still wins, so pinned/fixture clients are unchanged. This
also covers the prod-only and fleet routes and any later parent-side consumer.
The regression runs in the benchmark-live-results structural gate (campaign_inventory
selection). The Hub dotenv/interpreter half was not re-observed (this launch's
Hub upload succeeded) and remains as recorded, so the case stays open.

## Human feedback

The user reserved source/deployment ownership to the parent, prohibited full gates
and competing deployments, and required Freedom preservation. The parent requested
read-only native prerequisite proofs and will apply the prepared environment only
after the current round terminates.

## Reusable lesson

Resolve documented tool locations once in the supported CLI entrypoint before route dispatch, never per route or in a prepared operator shell.
