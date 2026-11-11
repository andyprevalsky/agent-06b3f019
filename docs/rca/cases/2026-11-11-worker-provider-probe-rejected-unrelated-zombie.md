---
id: 2026-11-11-worker-provider-probe-rejected-unrelated-zombie
date: 2026-11-11
title: Worker provider probe rejected an unrelated zombie with unreadable command line
surface: infra
component: worker-provider-runtime-probe
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/worker_pool_runtime.py RUNTIME_BROWSER_PROVIDER_PROBE.snapshot requires every process command before excluding zombies
symptoms:
  - "ValueError: Process command is unreadable"
  - "A healthy exact worker plus an unrelated zombie cannot produce provider evidence"
tags:
  - agentcard
  - cloudbench
  - provider-authority
  - zombie
  - preflight
sources:
  - PR #1864 review comment 4533470385
  - commit a5085083a51997a460a39fb8dd480ddacba70a52
repro: scripts/tests/cloudbench-provider-contract.test.py ProviderContract.test_actual_native_probe_skips_unrelated_zombie_with_unreadable_cmdline
status: open
---

## Problem

Review identified that an unrelated zombie can invalidate the read-only worker-provider observation. This is a confirmed local owning-boundary defect, not an attributed cause of the separate cloud canary failure or a claim about current production processes.

## Diagnosis

The actual embedded probe enumerates `psutil.process_iter(['cmdline'])`, then rejects any `None` command before deciding whether the entry is the canonical worker. A zombie may have a null command line. The registered fixture supplies that unrelated entry alongside one valid worker and executes the actual probe, with its original source/native-instance/provider/birth checks. On exact a508 producer bytes, it raises `ValueError: Process command is unreadable`.

Archive searches used `Process command is unreadable`/`RUNTIME_BROWSER_PROVIDER_PROBE` and `zombie.*cmdline`/`unrelated zombie`; no same-cause case was found. The Nov8 process-memory zombie case concerns terminal-thread-group memory accounting, not this provider-process filter. The Nov2 provider-contract case concerns independent configuration authorities, not zombie enumeration. These are related references, not duplicate diagnoses.

## Solution

The private patch requests process status and skips only `psutil.STATUS_ZOMBIE` before reading its command. Unreadable non-zombies still refuse; a zombie-only inventory cannot establish a worker, and a selected worker becoming a zombie still fails the existing native birth guard. No identity, source, provider, active-Machine or API completion check was weakened.

The identical-command final causal pair records exit1 before and exit0 after, with unchanged registered test bytes. Five focused runs passed, including the existing ambiguity, foreign-instance, source/provider and birth controls. The complete owning ProviderContract suite passed19/19. It is already an explicit recurring structural gate.

Proof is retained under `.context/agentcard-stability/review-cycle1-repairs-20261111/zombie/`: `final-exact-causal-pair.json`, final RED/GREEN logs, `green-commands.json`, `full-owning.log` and `source-manifest.json`. Patch SHA256 is `5829cbb5c980f30626d6cf1dbbf2896ecd1c787532be43e9c056ac3bdcd73cd2`; owning receipt SHA256 is `64009a50d512ee51e4f735dafcca869d86d58ef07bad26f6bc3289e093652709`. The parent independently accepted exactly this seal as CODE_ONLY in the retained `parent-code-review.json`.

## Open scope

OPEN pending parent application, affected public checks and deployment/runtime verification. No live probe, provider request, native benchmark or production process claim was made by these mocked tests.

## Human feedback

No incident-specific human feedback is recorded; the review comments and parent code review are technical findings, not user approval or native acceptance.

## Reusable lesson

Exclude positively identified irrelevant terminal process entries before requiring their command lines; retain strict refusal for unknown live entries and exact validation of the selected worker.
