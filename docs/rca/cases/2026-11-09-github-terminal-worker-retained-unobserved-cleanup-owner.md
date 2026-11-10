---
id: 2026-11-09-github-terminal-worker-retained-unobserved-cleanup-owner
date: 2026-11-09
title: GitHub worker completion left an unobserved cleanup owner without a typed reconciliation path
surface: harness
component: staged-deploy-github-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: retained_owners refused a timed-out GitHub adapter after its exact remote workflow and VM had completed because reconciliation supported only boxes and native owners
symptoms:
  - semantic-stack remained UNVERIFIED after its adapter deadline
  - normal reexecute was blocked by the retained GitHub cleanup owner
tags:
  - deploy
  - github-actions
  - cleanup
  - observation-loss
sources:
  - PR #1896
  - commit f852c494f2aa29d7c744686e651c8fe29aefd17a
  - plan:.context/deploy-pr1896-continuation/github-semantic/report.json
repro: python3 scripts/tests/deploy-test-github.test.py GitHubTerminalCleanup
status: open
---

## Problem

The semantic adapter exhausted its observation deadline while the exact GitHub
workflow 42676335136 attempt1 completed successfully. Original adapter timeout,
TERM and UNVERIFIED results remained authoritative. The cycle retained the
remote cleanup owner and correctly refused another launch, but no typed GitHub
cleanup reconciliation existed. Calling launch again would mutate remote state;
a result fetch is not a safe substitute for reconciliation.

## Diagnosis

Fresh run/jobs/artifact GETs and the server-digest-bound original artifact verify
the same source, deterministic request tag/token, attempt, worker and native
cleanup. The missing boundary is cleanup eligibility after observation loss,
not permission to adopt remote PASS into the cycle. Root source attribution is
INTRODUCED for the new reconciliation implementation's owning RED; the original
remote observation timeout mechanism remains UNKNOWN.

## Solution

Add a cleanup-only certificate through normal reconcile and retained-owner
revalidation. Bind latest receipt, original request/result/process/receipt bytes,
exact remote owner, workflow/source/tag/attempt, complete jobs inventory, server
artifact digest and same-token native cleanup. Fresh read-only remote GETs run
at issuance and every revalidation. More than 100 jobs fails closed rather than
assuming pagination. Network requests retain their existing retry/time bounds;
no hard total observer deadline is claimed.

Local closure requires strict distinct supervisor/child identities, unique
terminal wait PIDs excluding the supervisor, exactly one primary wait and exact
native-exit mapping. Independent review rejected the first candidate for its
missing primary identity binding; the same five registered methods produced ten
negative subcase failures before the guard and passed after it. Signal waits,
original timeout and TERM remain valid historical facts.

The normal full GitHub owning suite passed 53 tests in the repository Python
environment. The initial host-Python invocation lacked boto3 and is preserved
as dependency-setup failure, not product evidence. Five consecutive unchanged
new-test runs and the complete cycle suite are required before finalization.
Evidence, original rejected candidate and final independent clearance are kept
privately under .context/deploy-pr1896-continuation/github-semantic/candidate.

No original receipt is rewritten, no remote case PASS is adopted, and no provider
mutation occurs in the observer. New full semantic validation remains required.
Production, phone acceptance and overall deploy remain OPEN.

## Human feedback

The user requested completion of the deploy and continuation from the sister
thread. No new waiver or timeout change was requested. The AgentCard skip is a
separate explicit user override and grants no remote cleanup credit.

## Reusable lesson

Authenticate remote termination separately from test credit. Observation loss
must retain original failure evidence while allowing a narrowly proven new
launch; bind both local wait closure and the exact remote execution.
