---
id: 2026-11-02-worker-host-missing-required-lsof
date: 2026-11-02
title: Remote structural worker lacked the required lsof host executable
surface: infra
component: deploy-worker-provisioning
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: deployment preparation accepted a worker without establishing availability of the required lsof executable
symptoms:
  - "deploy structural gates need host tools that are not installed: lsof"
  - "dpkg-query: package 'lsof' is not installed and no information is available"
tags:
  - deploy
  - lsof
  - worker-provisioning
sources:
  - PR #1662
  - commit e99c91f55b9444f01a90bd4e8efc18315faeb51b
  - commit 6f3f53201faac3a3e70de099e7c211cee6770fad
repro: /var/tmp/rca-315f91-lsof/verify_preflight.py
status: open
---

## Problem

Occurrence 315f91b72f4a43cbb83192aafe42a288, attempt 12 final, returned
UNVERIFIED, native exit 1, complete=false. The original full three-line native
log hashes to 23aa7cc93fdf8ef1e1c7fbf3194ff382b75cd120b1aa8cbfbb7237dfa3c72c9b.
The worker is fee320d8-313e-4367-ad18-41c3001e69db with root
/home/boxes/rose-validation-structural-c. The original command was bash
scripts/run-deploy-stage deploy-command-structural -- python3
scripts/run-deploy-structural-gates.py --max-workers 4. No assertion suite ran.
Worker-native dpkg and command-v observations at 2026-11-02T20:21:29Z confirm
that lsof was absent. Timeout, cancellation and lingering process group are
false; cleanup_complete is true. This is not external-provider credit/outage
evidence.

## Diagnosis

Path: prepared worker -> native stage -> structural main() -> shutil.which(lsof)
-> exit 1 before run_gates -> aggregate UNVERIFIED receipt.
The literal host prerequisite is unchanged at frozen e99c91f55b9444f01a90bd4e8efc18315faeb51b,
current main 6f3f53201faac3a3e70de099e7c211cee6770fad and original base
a3c4929f3bbd296766013a7545439b682015a6ef. Main, parser, prerequisite tuple,
and environment helper ASTs hash identically at all three revisions:
1df6a12d2d4a1cea793e26348f21d678d27dce915c1ccbe5f49df1303c9e1bf0.
Entire cloud-init.sh bytes also match, including ensure_apt lsof lsof.

Private unmodified copies were imported by the same verify_preflight.py,
with only run_gates replaced by a downstream observation spy that runs no
suites. All three fail with the same native missing-lsof line under an empty
controlled PATH. Adding a symlink to the installed real /usr/bin/lsof in
that same PATH makes each identical command and assertion pass. Commands,
outputs, timings and hashes are in /var/tmp/rca-315f91-lsof/comparison.json.
This proves the prerequisite mechanism and the environment-only repair,
not full suite success.

Gate: INTRODUCED (deployment integration, not a changed lsof validator).
The frozen PR adds explicit non-quick worker bindings in deploy_test_plan.select
and deploy_test_bindings.generate. Baseline 6f3f53201 instead launches the stage
with cwd=ROOT / lane.cwd in run_deploy_pipeline.py. The exact e99 readiness
receipt at .context/preparation/final-workers/e99c91f55b9444f01a90bd4e8efc18315faeb51b/deploy-command-structural-result.json
accepted this new worker as ready before the recorded native gate. That record
names the same host, root, source and digest as the failing request. The original
preparation excerpt states tests_run=false; the receipt records source and protected-file verification but contains no
host-prerequisite verification. The recorded worker lacked the existing
mandatory executable when that accepted route first executed. Parent confirms
this newly prepared worker and readiness acceptance are part of PR1662 and owns
the provisioning omission. Identical gate-code failure on all revisions therefore
does not justify a NOT_INTRODUCED deployment waiver. A prior same-host baseline
is not claimed. The first-bad integration boundary is the acceptance of an
insufficiently prepared worker; the downstream preflight correctly refuses it.

Searches used the full literal missing-host-tools message and lsof missing
deploy structural prerequisites, then literal archive grep. Related observations
exist in the project-folder canonical fixture and context-pairing cases; neither
is a dedicated diagnosis of this occurrence or proof of its deployment attribution.
The archive is a lead, not causal evidence. Adversarial reviewer ph7dskgkv12nxtht1jyw4aqj4n8hf4qq independently verified the
three Git copies and six controlled cases, and approved INTRODUCED for deployment
integration with the above detection-versus-origin and evidence-scope distinctions.

## Solution

The worker owner executed sudo apt-get install -y lsof, installing exactly one
new package (4.95.0-1build3), with no upgrades or removals. The native install log
and verification receipt confirm /usr/bin/lsof, clean unchanged e99 source and
digest, and unchanged protected/config content and modes. No gate was rerun.
The exact controlled preflight fail/pass above verifies the repair mechanism;
the complete deployed gate remains UNVERIFIED pending the parent's next cycle.
Keep the recorded source/digest and protected configuration unchanged. Do not
change the existing preflight, waive assertions, or alter timing budgets.
The existing documented cloud-init already includes this package; no application
source fix is warranted by the observed first-bad boundary. Before any claimed
full gate success, the parent must run its unchanged final cycle with original
assertions. The private fixture is causal proof only.

Delete/unify/guard assessment: deleting the prerequisite weakens required process
ownership checks; adding a second package installer is unnecessary. Use the
existing provisioning contract and verify the supplied host satisfies it.
Golden reference: not applicable (no approval-gated hunk).
This is a private draft for parent archival; no frozen source or canonical
archive has been edited and no full gate has been launched.

## Human feedback

The user requires a bounded, evidence-backed attribution investigation,
preserves Freedom, reserves source and deployment ownership to the parent,
and prohibits full gates or application edits in this worker. The parent
requested only lsof package preparation; the executor requests that revised
instruction directly from the parent before changing its original read-only scope.

## Reusable lesson

Verify required host executables on each selected worker before accepting its preparation receipt, and distinguish unchanged gate code from deployment-wide provisioning attribution.
