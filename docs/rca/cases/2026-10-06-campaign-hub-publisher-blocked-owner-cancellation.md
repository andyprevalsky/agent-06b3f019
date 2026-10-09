---
id: 2026-10-06-campaign-hub-publisher-blocked-owner-cancellation
date: 2026-10-06
title: Campaign Hub publication blocked cancellation of its owning CLI
surface: infra
component: benchmark-campaign-hub-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py publish_campaign_group synchronous subprocess.run
symptoms:
  - campaign cancellation remained blocked in starting publication
  - campaign cancellation remained blocked in final publication
  - SIGTERM recorded but Hub uploader remained alive
tags:
  - benchmark-campaign
  - hub-publication
  - cancellation
  - subprocess-ownership
sources:
  - PR #1424 review comment 4202918191
  - commit c214f5199646cb3bb51a81ef243df8ee01991536
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py test_campaign_inventory_group_publication_cancellation_retires_only_its_owned_processes
status: fixed
---

## Problem

The campaign signal handler recorded cancellation while a synchronous Hub
schedule upload still blocked the CLI. The actual campaign owning control
observed both startup and final upload children, sent SIGTERM to the exact
campaign parent, and failed its generous fifteen-second join for both phases.
The source baseline was c214f519; the paired run recorded two failures in
31.30 seconds. Original logs remain private. This is an owning CLI failure,
not a claim that an unchanged benchmark evaluator failed.

## Diagnosis

The first bad boundary was `publish_campaign_group` calling `subprocess.run`
without observing the campaign's existing stop signal. The uploader's socket
transport timeouts did not join the parent's cancellation authority. Startup
publication could prevent child admission; final publication occurred after
resource cleanup and after the campaign's return status had already been
computed. Setting a flag alone therefore left both the publisher and CLI alive,
and final cancellation could return a stale successful campaign status.

Archive searches used `campaign synchronous group publication cancel SIGTERM`
and `publish_campaign_group inventory lost cancellation child process`. The
schedule-publication case is a relative with a different first bad boundary:
it owns missing membership, not cancellation of a running publisher. The
smallest coherent fix is auxiliary subprocess lifetime ownership; no prompt,
model, task definition, evaluator or benchmark execution budget changes.

## Solution

Supervise the normal uploader in an isolated session, observe the existing
campaign cancellation signal, and reuse the seed helper's existing exact
auxiliary-session drain with its generous cleanup headroom. Load that helper
before child allocation so setup failures cannot abandon a publisher. Preserve
nonzero publication as a visible pending warning, preserve completed child
verdicts, skip new admissions after cancellation, and include final publication
in the original campaign lifetime and cancellation return status. No extra
per-upload rejection timer is added. At 10k tasks there are still two parent
schedule handoffs, rather than one publisher per task.

Two controls exercise the actual campaign and native publisher plus descendant
for startup and final cancellation, while an unrelated process must survive.
The final candidate passes both under the same join assertion; the complete
owning family passes 17 tests with one unchanged Linux-only skip in 30.71 seconds.
Independent source review confirms cancellation ownership and preserved child
verdicts. The final unchanged artifact was also rerun against the baseline. The test name
is selected by the existing `campaign_inventory` deploy control; no separate
paid or large verification stage is introduced.

## Human feedback

The user required generous infrastructure timing, stage endstates and the
original whole-run wall-clock ceiling, rather than many narrow assertion
timers. Healthy runs must continue on stale observations. Quick owning
regressions must be cemented in ordinary deploy, without a massive new suite.

## Reusable lesson

Supervise auxiliary publication under the original campaign cancellation owner and join its exact processes before returning a terminal CLI status.
