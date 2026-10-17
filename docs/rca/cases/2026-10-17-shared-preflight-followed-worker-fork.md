---
id: 2026-10-17-shared-preflight-followed-worker-fork
date: 2026-10-17
title: Shared infrastructure preflight waited until after the worker cohort was forked
surface: infra
component: cloudbench-campaign-preflight
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: the campaign starts its worker cohort before children enter the shared N2 preflight transaction
symptoms:
  - concurrent startup processes wait on one shared infrastructure canary
  - "infra canary preflight: stamp missing/stale"
tags:
  - cloudbench
  - startup
  - concurrency
sources:
  - commit 59ab01b35aa91521e105a3d48e1587007aa347ad
repro: python3 scripts/tests/cloudbench-cleanup-ticket-campaign.test.py
status: open
---

## Problem

The campaign already runs its shared seed preflight before starting the workers. Its shared N2 infrastructure check is instead reached inside each worker, after the campaign has forked the cohort. Many startup processes can remain resident while one shared prerequisite is still running.

This report concerns startup ordering. It does not claim that moving the check alone fixes controller memory pressure, every observed timeout, or the original600 benchmark outcome.

## Diagnosis

The source path is campaign cleanup-budget preparation, parent seed preflight, worker dispatch, and then worker infrastructure-preflight lock acquisition. The owning campaign control exercises the actual producer and cleanup tickets. The old path starts task workers before the shared check; the corrected path completes the check first. Failed and cancelled checks start no task workers, and cancellation waits for the exact canary child. Further controls retain the original task ref and cold-start policy, reject foreign receipts, and preserve cached-stamp expiry. These establish the ordering mechanism, not a 600-worker capacity qualification.

## Solution

Run the canonical shared N2 helper in the parent before task-worker dispatch, debit the same existing nested cleanup slot, and pass a small source/cohort-bound success receipt to workers. Keep the normal all-ready barrier and each worker's fresh lease/CAS. Cancellation joins the helper and its exact owned canary child before the parent can proceed. The parent retains the existing TTL policy; accepting an existing stamp neither reruns N2 nor refreshes its timestamp. Children consume a small source/cohort-bound receipt instead of repeating shared setup or parsing the full cohort manifest.

## Human feedback

The user requested a simpler startup architecture while preserving full parallel task execution. Moving a shared prerequisite before worker creation is distinct from reducing task concurrency or extending deadlines.

## Reusable lesson

Complete a cohort-wide prerequisite before allocating the full cohort's waiting processes; retain per-worker checks for state that actually differs per worker.
