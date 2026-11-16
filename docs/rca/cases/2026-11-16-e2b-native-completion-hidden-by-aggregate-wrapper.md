---
id: 2026-11-16-e2b-native-completion-hidden-by-aggregate-wrapper
date: 2026-11-16
title: E2B aggregate wrapper cannot distinguish completed failure from interrupted execution
surface: harness
component: deploy-e2b-completion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: deploy_test_worker.run_step unconditionally classifies every nonzero E2B aggregate exit as UNVERIFIED
symptoms:
  - 'unverified/incomplete execution cannot be waived as a completed case'
  - 'session_capabilities timed out'
  - 'E2B_SMOKE_VERDICT FAIL exit=1'
tags:
  - deploy
  - e2b
  - native-evidence
  - aggregate-case
sources:
  - PR #2404
  - commit 89617d47c6551baacd095a8447b5da19fe419b72
repro: scripts/tests/deploy-test-e2b-completion.test.py
status: open
---

## Problem

Required E2B native run43916830630 on89617d47 records two real failed attempts
of the existing Claude2+2 smoke: session_capabilities timed out,43103ms/42562ms.
Each attempt ran59 cases:58PASS1FAIL. The generic worker instead records
UNVERIFIED/completefalse because the E2B recipe is aggregate. The coordinator
correctly refuses to waive an incomplete execution. Original receipts and both
attempts stay unchanged; the selected OAuth weekly429 does not establish that
the capability timeout was external.

## Diagnosis

The original command is bash scripts/run-deploy-semantic-stack.sh --e2b-smoke-only.
The blackbox runner writes a per-domain summary, but abortedfalse alone does
not rule out a child timeout, spawn error or crash. The shell also suppresses
sandbox cleanup errors. Thus merely accepting that summary as a completed
failure would weaken the guard. Native per-case terminal evidence and nested
cleanup proof are the missing producer contract, not a faulty strictness rule
in the coordinator. The live-probes aggregate cases of Nov9/11 are relatives;
this exact E2B source path lacks their constituent evidence. Actual PR2406
terminal-result work was read: its withdrawn retrospective semanticPASS import
is a different boundary, and the owner received distinguishing evidence.

The independent E2B attribution packet reproduces the capability timeout on
baseline770611c7 and89617d47. That product failure is NOT_INTRODUCED; native
post-exit versus lost-transport causality remains unproved. This collection
repair does not repair the capability RPC or complete the Claude task.

## Solution

Add native completion records only at the existing Claude domain's normal
final summarizeResults call. They retain every original case name, error,
status, duration and counts, one append-only file per actual process/attempt.
Add optional read-only, exact-stack post-teardown verification, bounded to ten
provider pages. The shell records both backend-tree and sandbox cleanup facts.
All assertions, definitions, attempts, concurrency and timeouts remain.

The worker recognizes only the original E2B command/case/cwd/aggregate contract.
A nonzero1 can become completeFAIL only with one new owned artifact directory,
matching summary/progress, all terminal attempt records with consistent case
identities/counts and no skips, and verified backend/provider cleanup. Unknown,
missing, stale, conflicting, aborted, interrupted or lingering execution stays
UNVERIFIED. This path grants no positive PASS credit. Existing source, request,
recipe, input/environment and cleanup checks remain in the enclosing worker.
No coordinator admission API or retrospective receipt mutation is added.

The same local regression command fails against the original worker and passes
against the candidate; the native-summary fixture has original SHA256
 dec9a2c1e70e02bf8a9fe2e7fdf029a6cf6543a83ebc408c87f40b114ce36546.
Additional terminal/cleanup records in this offline test are explicit controls
for the new producer contract, not invented historical artifacts. The actual
historical native capture still returnsUNVERIFIED under the new collector
because those records were absent. Fresh native execution is required.
Five unchanged collector and producer regression runs passed. The existing
worker suite passed200tests in155.427s. Final review/native qualification and
production delivery remain open.

This deploy-only evidence collection has no planner trajectory or production
agent query/subscription effect at10000agents. Optional cleanup verification
adds at most10read-only provider pages to a smoke teardown, no model calls.

## Human feedback

None recorded. Independent review required terminal attempt evidence and owned
nested cleanup rather than accepting a failed domain summary alone.

## Reusable lesson

Collect terminal native attempts and owned cleanup before distinguishing a completed failure from incomplete aggregate execution.
