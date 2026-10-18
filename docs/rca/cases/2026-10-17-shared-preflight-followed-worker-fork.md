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
  - "KeyError: 'CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'"
  - canonical parent N2 failed before worker admission
tags:
  - cloudbench
  - startup
  - concurrency
  - environment
  - mutation-authority
sources:
  - commit 59ab01b35aa91521e105a3d48e1587007aa347ad
  - commit 0000435cd1fab76a4285e7c97da6e8177eced026
  - fleet run original600-1792277195318370552
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

### Original76 follow-up: parent mutation authority

Original76 reached the new parent preflight, then canceled all600 logical jobs before any task attempt. The retained N2 log records five failed clone attempts for each of its two members, ending in `KeyError: 'CLOUDBENCH_CAMPAIGN_MUTATION_AUTHORITY'`. The parent ran498.427seconds. Its caller and monitor joined; controller deletion and workspace `pending_destroy` were verified. The old run is a failed outcome, not a qualifying600 run.

The parent had already minted its source-bound mutation authority and started its shared inventory publisher. Its N2 environment inherited the mutation-admission flag but omitted the authority and inventory-directory values. Those values were assigned separately only in the later worker-dispatch path. The checked clone launcher read the missing authority before its provider-dispatch boundary. The earlier campaign fixture disabled shared inventory and used a canary wrapper that never entered this production mutation gate, so the ordering regression did not exercise this prerequisite.

The focused repair unifies these two environment bindings for parent N2 and task-worker dispatch. It passes the existing parent-minted values, clears inherited values when absent, and leaves source, publisher, freshness, scope, cleanup, timeout and concurrency checks intact. The owning regression follows campaign → real preflight → nested wrapper → production checked mutation launcher. The old source reproduces the missing-key failure; the candidate reaches the checked N2 boundary before worker dispatch. `python3 scripts/tests/cloudbench-cleanup-ticket-campaign.test.py` passed all10 controls in11.890seconds, including changed-source, foreign-feed, retired-publisher, ordinary-worker, cancellation and TTL checks. The frozen author manifest is `19a26c4ffd46d42b744a9d536dcee8c1be353dc51023f6f17733d4011e79dd8e`; independent review verified its two source and six proof hashes. This is local causal evidence with zero provider calls, not proof of a successful600-task run. The exact original600 outcome remains unproved; this case stays open.

Reference implementations support constructing the child environment in one place: `hermes-agent/tools/environments/local.py:350` (`build_subprocess_env`), `openclaw/src/process/exec-spawn.ts:444` (`resolveCommandEnv`), and `codex/codex-rs/core/src/spawn.rs:45` (explicit child environment followed by `env_clear`/`envs`). `claude-code-src/src/utils/execFileNoThrowPortable.ts:72` also supplies the complete environment to its process launcher. These are general environment-construction analogs, not substitutes for Rose's mutation-authority proof.

## Human feedback

The user requested a simpler startup architecture while preserving full parallel task execution. Moving a shared prerequisite before worker creation is distinct from reducing task concurrency or extending deadlines.

## Reusable lesson

Bind a shared prerequisite to the same source-owned execution context as its consumers, and complete it before allocating their waiting processes; retain per-worker checks for state that differs per worker.
