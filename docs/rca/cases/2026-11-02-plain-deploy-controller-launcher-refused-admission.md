---
id: 2026-11-02-plain-deploy-controller-launcher-refused-admission
date: 2026-11-02
title: Plain deploy controller launcher refuses before running its suites
surface: infra
component: run-cloudbench-controller-gate
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The documented plain deploy invocation enters early_controller_admission without disposable-controller authority and exits 78 before any suite or provider call
symptoms:
  - Controller capacity gap: reuse an existing retained controller; new Machine creation requires measured admission, which this entrypoint does not provide.
  - cloudbench-controller UNVERIFIED native_exit 78
tags:
  - cloudbench
  - deploy
  - admission
sources:
  - PR #1662
  - agent https://boxes.dev/thread/thr_ea378342e89048f68502af561db359e9
  - commit 067495d51582f3946d5a5b980ccc8416b66dff02
  - commit 6f3f53201faac3a3e70de099e7c211cee6770fad
  - plan:/var/tmp/staged-deploy-implementation/.context/deploy-pipeline/rca/3ffff5ab07894174a45e8d734a22802c.json
  - plan:/var/tmp/pr1662-rca-cloudbench-3ffff5ab/comparison.json
repro: python3 /var/tmp/pr1662-rca-cloudbench-3ffff5ab/reproduce.py
status: open
---

## Problem

Occurrence 3ffff5ab07894174a45e8d734a22802c ran the ordinary cloudbench-controller
deploy command on a prepared Linux worker. Its native result was UNVERIFIED,
exit 78, from 1793652559.4968355 to 1793652559.9636796 (0.466844 seconds).
The full native log SHA256 is
7313ae96efd346defdb425d4a97b7b921f3d39c835a88edea248aba87126683a.
The full stage log SHA256 is
9f84fb5cbb36965ab332d6883d68b9554a2cd9dd50a74fc3badee8fb91635227.
The recorded worker supplied both originals and the exact request/result.
No GATE_STEP or GATE_RESULT exists in these logs; the constituent suites did
not execute. A separately passing operator preflight is not a controller pass.

## Diagnosis

Gate: NOT_INTRODUCED. Compared origin/main baseline
6f3f53201faac3a3e70de099e7c211cee6770fad with frozen PR source
067495d51582f3946d5a5b980ccc8416b66dff02, digest
b903608660c4e2a99a9025b2968240d9d908137d405c0479ff385de092031da1.
The launcher and operator preflight are byte-identical across these revisions;
their SHA256 values are respectively
8573f2f47b118efb8ce3be9fc62187a2ca5e2f6cf1adad2e10c271f1edfddeda and
1d170afdb2a01ecfb1bd8311d1b8798f8253f714919dc46915411ec46f629d75.
Baseline deploy.md line 1255 already invokes the same plain launcher through
run-deploy-stage. The new staged invocation preserves that failing argument
contract, rather than introducing it.

Critical path: exact dispatch arguments -> launcher operator preflight ->
DISPOSABLE_AUTHORITY initialized empty -> no --disposable-controller argument ->
early_controller_admission (line 224) -> controller_machine_creation_admission
(lines 152-164) -> exit 78. There is no environment-variable retained-controller
selector in this path. A current absent-env observation is not historical proof;
the worker did not capture the full inherited environment. That gap does not
affect this attribution because authority is initialized by the script and only
set by command arguments, whose original values are captured.

The private replay copied the two complete files from each exact Git revision,
ran bash scripts/run-cloudbench-controller-gate with an executable flyctl
sentinel, and observed the identical native error and exit 78 on both sides.
Baseline took 0.034387 seconds; frozen took 0.032648 seconds. The sentinel was
never invoked. An initial fixture attempt lacked a Git ref and added an
irrelevant git-not-a-repository diagnostic; it was rejected and corrected by
supplying the explicit revision, with original events retained. No production
code was edited and no full gate was launched.

The refusal is proven locally and predates this PR (blame identifies
043659fa80 for the refusal and 82c7ca7bb0 for its explicit-authority path).
This is attribution evidence, not a completed repair RCA: there is no
post-fix pass or unchanged full-suite outcome. No provider request occurred,
so no outage or credit exception is established.

Archive searches: Controller capacity gap; retained controller reuse missing
machine; exact literal search across docs/rca/cases. No literal hit exists.
The controller flyctl-bound and missing-client cases were read and are
relatives, with distinct post-admission boundaries. No shared cause is claimed.

## Solution

Repair is open and remains owned by the parent.
Reconcile the deploy invocation with the existing admission contract while
preserving all constituent assertions: either use the complete native suite
runner on the already provisioned isolated Linux worker, or the separately
authorized and verified controller path. Do not remove the allocation guard,
invent a retained-machine environment variable, grant a provider exception,
or treat the passing preflight as the full gate. A permanent test must exercise
the ordinary deploy invocation before calling the repair complete.
Golden reference: not applicable (no approval-gated hunk).

A concrete candidate is retained in local-runner-complete.patch, SHA256
e5643c4dfe3186146e377607394e274e28310e8137fb3d058eacadebb7994925.
It adds a local Linux suite runner, selects it in the staged standard template
without a platform omission, and adds LocalController tests to the existing
registered deploy-test-worker suite. The public Fly launcher is unchanged.
The runner preserves all twelve documented commands, parallel child processes,
private TMPDIRs, per-suite native logs and exit codes, source identity and
failure/unknown distinctions. The separately selected agents coverage gate
owns the conditional benchmark domain. Five consecutive focused regression
runs passed. A private native scheduler fixture measured twelve concurrent
children and distinct temporary directories; exit 1 remained FAIL, exit 78
remained UNVERIFIED, and aggregate failure remained nonzero. A passing fixture
also retained all twelve results. These are runner tests, not execution of the
reported full controller gate. Candidate review and actual outcome remain
parent-owned and open.

The recorded worker independently reviewed the attribution: both source hashes,
ancestor relationship, identical documented invocation and exact admission
branch. It found no blocking gap in the restricted NOT_INTRODUCED finding.
Its review was a source/evidence check, not an independent full-gate execution.

This case is a private draft because the parent explicitly retains source
ownership. It is not added to the deployment snapshot and does not claim an
implemented fix, permanent regression, or full gate pass.

## Human feedback

The user limited this worker to evidence collection, private temporary
reproduction and an optional exact fix draft; no application source edits,
new deployment, full gates, weakened assertions, timing budgets or unknown
work are authorized. Preserve Freedom. Qualified handoff and RCA completion
are separate.

## Reusable lesson

Exercise the ordinary deployment entrypoint against its current admission contract before relying on the underlying suite's availability.
