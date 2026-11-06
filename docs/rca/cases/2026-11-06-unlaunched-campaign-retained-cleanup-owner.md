---
id: 2026-11-06-unlaunched-campaign-retained-cleanup-owner
date: 2026-11-06
title: Smoke startup failure retained cleanup ownership despite admitting no controllers
surface: harness
component: staged-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: native cleanup reconciliation required fleet audit evidence even when campaign startup admitted zero controllers
symptoms:
  - "native cleanup: unsupported proof layout"
  - "campaign job did not terminate normally"
  - "FileNotFoundError: [Errno 2] No such file or directory: 'flyctl'"
tags:
  - deploy
  - campaign
  - cleanup
  - pre-admission
sources:
  - PR #1708
  - commit 7c43796a1ce4aef27c783566f180080063fe85f4
repro: scripts/tests/deploy-test-cycle.test.py
status: open
---

## Problem

The browser repair's first staged cloud smoke attempt stopped during coordinator startup because the parent could not execute flyctl. Its native summary recorded nine cancelled jobs, peak concurrency zero, no controller PID or task start, and an empty native runs directory. The original adapter correctly left all nine checks UNVERIFIED, but the resulting retained cleanup owner prevented execution recovery after the missing executable was installed.

## Diagnosis

Gate: INTRODUCED at deploy-worker preparation: this deploy newly launched the smoke campaign without preparing the documented Fly executable in the coordinator PATH. The browser application changes did not modify the campaign or cleanup module. The November 2 campaign-environment case describes the same prerequisite failure; this case records the distinct subsequent custody boundary.

The existing campaign reconciliation requires each terminal job to have an integer controller exit, a monitor handle, and a sealed fleet audit. A startup that never creates a controller cannot produce those records. The permanent unchanged reproduction returns `native cleanup: unsupported proof layout` before the repair. The original receipt, adapter, native summary, publisher acknowledgement and private logs remain under `.context/deploy-pipeline/attempts/2/initial/smoke/` and its request-owned `.context/deploy-cloud/` directory. A read-only proof replay against that real occurrence verifies the new boundary after repair, with no test credit.

The related November 3 native-campaign reconciliation and November 4 local-Card pre-admission cases establish analogous ownership distinctions; neither handled this zero-controller cloud campaign. The deepest owned cause is conflating never-admitted startup custody with the evidence contract for allocated fleet resources. No model decision caused it.

## Solution

Add an explicit launch-only proof layout for the exact missing-flyctl startup boundary. Require the original receipt and adapter hashes, exact campaign/task membership, peak concurrency zero, every task cancelled without any admission timestamps/PIDs/exits/attempts, absent job logs, an empty native fleet directory, stopped inventory ownership, no open startup log holders, and the native terminal publication acknowledgement. Preserve every original UNVERIFIED outcome and grant no execution credit. A later run must still execute the complete smoke inventory.

Two permanent regression tests prove acceptance of the zero-admission state and rejection of admitted cohorts, active writers and job logs. Before the repair the acceptance test fails; afterward both pass unchanged. Full coordinator regression validation and the unchanged cloud smoke rerun remain part of this deploy. The proof is evaluated only during explicit recovery, proportional to that campaign's selected jobs and three startup logs; it adds no application polling or 10k-agent fan-in.

Golden reference: not applicable (no approval-gated hunk). Managed delegation remains unavailable with the already recorded `delegation_service_unavailable` response; no investigator is claimed. Status remains open until the deployed source and final smoke acceptance are verified.

## Human feedback

None recorded.

## Reusable lesson

Represent zero-admission startup custody explicitly, and clear launch ownership only from native evidence without rewriting missing execution as success.

### Relay-startup custody

The next native attempt found the executable but rejected its Fly agent version: the installed 0.5.5 client did not match the relay's explicit 0.4.115 protocol. Gate: INTRODUCED by this deploy's unpinned tool installation. Install 0.4.115 from the official release, verify its published SHA256 and version, and preserve the earlier binary. The second native campaign again admitted zero controllers and no fleet, but recorded joined bootstrap/broker children with isolated-agent retirement still unverified.

Add a separate startup-relay proof that retains those original pending flags. Bind the original authority, producer births, logs and native archive; require the exact startup parent and children retired, no broker readiness or socket, no official Fly process inheriting the unique socket path, and no startup log holders. A controlled live process with that socket scope must block recovery. This remains launch admission only, never task credit or a waiver. The exact real failed campaign passes this read-only custody proof, and the permanent acceptance fails under the pre-fix helper then passes unchanged after repair. All 158 coordinator tests pass, including the original missing-executable proof, live-agent rejection, and foreign-host/live-parent rejection. Producer birth identities must belong to this machine boot. The unchanged smoke inventory must still execute with the pinned tool.
