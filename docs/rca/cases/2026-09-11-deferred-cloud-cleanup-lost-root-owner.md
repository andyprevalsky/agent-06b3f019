---
id: 2026-09-11-deferred-cloud-cleanup-lost-root-owner
date: 2026-09-11
title: Deferred cloud cleanup lost the root agent owner identity
surface: agents
component: benchmark-cloud-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: deferred batch cleanup used the ambient default identity after the task restored its fixture identity
symptoms:
  - "POST /api/agents/root/pause returned 404"
  - "pause was not acknowledged"
  - "Cloud evidence finalization failed: TimeoutError"
tags:
  - cloudbench
  - ownership
  - auth
  - browser-recording
sources:
  - PR #1299
  - fleet run 20260911-033741-76727
  - agent 6acd3a74-3d4d-4dcc-b990-11da3e1674bd
repro: agents/benchmarks/cloud_batch_cleanup_test.py::test_deferred_cleanup_uses_exact_database_owner
status: open
---

## Problem

Attempt eleven accepted three sequential ten-task slices, then failed on slice
four. The gate-kyc-card-mint business assertion passed in 63.7 seconds, but its
final durable browser evidence was incomplete. The browser had a finished
recording and no terminal task_complete row. The existing validator correctly
rejected that evidence. The campaign stopped and the first three slices do not
constitute the requested ten consecutive slices.

The captured backend trace returned 404 for pause at 10:57:39.271 UTC. Sixty
seconds later the archive barrier expired. Canonical DELETE then sealed the
root and exact provider cleanup succeeded, but resource recovery does not make
the failed task evidence valid. The complete backend, worker and driver logs
were preserved before exact owned machine recovery. Independent reads verify
all ten roots' browser-provider receipts terminal.

## Diagnosis

The KYC task runs as synthetic user 00000000-0000-4000-8000-000000000103.
run_single_task restores BENCHMARK_RUN_USER_ID before the deferred batch
finalizer runs. The finalizer calls the normal pause client without retaining
that identity. The backend pause route looks up the agent by both ID and user,
so the default benchmark user receives 404 even though the root still exists.

The local owning-boundary reproduction calls the real _api_headers and
pause_agent against a local HTTP server enforcing ownership. The exact-owned
DB seam supplies two roots with distinct fixture owners; the ambient identity
is the default user. On HEAD55d1ea3cf, both pauses are rejected and the unchanged
reproduction fails with pause was not acknowledged. Command:

    PYTHONPATH=agents agents/venv/bin/python -m pytest -q .context/setup/owned_identity_repro_test.py

Evidence: .context/acceptance/owned-identity-repro-before.log. The exact unchanged
canonical local KYC task with the cloud owned-batch cleanup contract also failed
on the buggy source. Root 76960702-3d44-4890-8526-e02892e75240 passed the business
assertion in 87.8 seconds, then pause returned 404 at 11:15:24.806 UTC and the final
recording barrier raised TimeoutError. The saved task outcome is ERROR, not the
earlier business PASS. Exact provider cleanup succeeded and the isolated stack
stopped. Evidence is kyc-owner-exact-local-before.log and
agents/benchmarks/runs/20260911_111628_gate-kyc-card-mint.json.

Canonical command (unchanged before and after):

    /opt/homebrew/bin/bash .context/setup/run-kyc-owned-identity-repro.sh

That wrapper invokes scripts/run-bench --local gate-kyc-card-mint with its existing
catalog task and the real owned-batch cleanup env contract. A prior launch failed
the contract before allocating an agent because local context paths resolve
relative to agents/. A single run-owned context symlink maps that relative path
to the actual isolated stack directory for both before and after runs. No task
prompt, evaluator, fixture or timeout has been modified. The root execution
backstop is 300 seconds as required for this validation.

## Solution

Read the root owner from the same exact-owned local database query that
establishes browser-session ownership. Use a ContextVar to bind pause, archive,
DELETE and provider finalization to that persisted user, then reset the context
even on cancellation. Missing or malformed owner evidence fails closed. Normal
root backstop stays 7200 seconds; this validation stays 300 seconds. Recording
readiness remains 60 seconds, and all provider and shutdown limits remain intact.

The identical owning-boundary command now passes. Together with the full local
cleanup suite, 17 checks pass. Linux passes 21 cleanup/driver/recovery integration
checks and the complete benchmark blackbox group. Independent review passed all
16 permanent cleanup cases and injected cancellation at pause, snapshot,
archive, delete and provider-release awaits. Each restored the pre-existing
outer identity without mutating ambient env. Null, empty, integer, malformed and
newline-bearing owner evidence was rejected. The standard recovery query shape
is unchanged unless the existing sealing-state mode is requested.

The first exact local after-run confirmed pause now returns 200 and the captured
owned database snapshot contains the correct fixture owner. It still failed the
archive barrier because the workflow manager returned from the rejected KYC gate
without a browser task_complete event. That independently reproduced producer
bug is recorded in 2026-09-11-browser-gate-abandonment-omitted-terminal. The saved
run is 20260911_112040_gate-kyc-card-mint.json, root
be3e9990-ad3f-45dc-8230-70a94f9fe04d. This narrows the first fix's proof to the
identity boundary; it does not claim the overall benchmark is fixed.

The exact unchanged local KYC command passes with both fixes in 72.8 seconds:
run 20260911_112644_gate-kyc-card-mint, root
c06f7817-42ff-4239-a3cc-9025212c0976. Its task outcome is PASSED, the owned cleanup
acknowledgement is clean, and the isolated stack is stopped. The canonical
evidence publisher verified all browser terminals and recordings at
https://www.roselabs.ai/?agent-id=c06f7817-42ff-4239-a3cc-9025212c0976 (27 messages).
The macOS wrapper changes only the artifact output directory; it runs every
canonical Hub and FE check without skip flags. Its manifest and last LLM dump
are under .context/acceptance/rca_evidence/c06f7817-42ff-4239-a3cc-9025212c0976/.

The full browser blackbox suite passes on macOS and Linux. The first Linux
review-container attempt lacked the Playwright headless binary; installing the
matching browser and native dependencies made the unchanged full suite pass.
Independent review additionally passed fifteen write/auth/error/cancellation
and pending-resume checks, including existing successful-resume controls.

Eighteen manager scenarios are now permanent: seven payment abandonment paths
plus eleven write/auth/error, exact-ID fallback, pending-resume and cancellation
cases. Both additions are registered in the browser blackbox runner. Independent
provider GET verifies the successful local run's browser terminal; Docker
confirms its exact isolated database container and volume absent.

The cloud KYC retry and fresh frozen ten-by-ten proof remain required; this case
stays open until that outcome evidence is complete. This case remains open and is not a completion claim.

## Human feedback

Finish without permission prompts. Require ten sequential slices of ten actual
cloud tasks with zero infrastructure failures, exact resource teardown and
durable evidence. Keep a 120-minute normal backstop and use five minutes only for
this validation. After completion explain deploy selection and a global 20-bench
budget proposal.

## Reusable lesson

Deferred cleanup must retain or recover the resource owner identity instead of
using the caller identity left after task-local scope has ended.
