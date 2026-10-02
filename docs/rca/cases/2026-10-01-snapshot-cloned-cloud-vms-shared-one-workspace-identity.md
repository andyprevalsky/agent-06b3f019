---
id: 2026-10-01-snapshot-cloned-cloud-vms-shared-one-workspace-identity
date: 2026-10-01
title: Cloud VMs cloned from one snapshot shared a workspace identity, so their stacks fought over one ngrok domain
surface: infra
component: cloud-provisioning
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/cloud-build.sh derived CONDUCTOR_WORKSPACE_NAME from /etc/machine-id and kept any existing .cloud-env
symptoms:
  - ERR_NGROK_334 The endpoint 'https://rose-cloud-44cb5599.ngrok.app' is already online
  - ngrok exited before the public tunnel became ready
tags:
  - cloud
  - ngrok
  - temporal
sources:
  - PR #1364
repro: scripts/tests/workspace-env.test.sh
status: fixed
---

## Problem

The `/deploy` Step 5 stack (`scripts/run.sh --benchmark`) stopped about 25 seconds after start on a Cursor Cloud VM. ngrok refused the frontend tunnel with ERR_NGROK_334, because `rose-cloud-44cb5599.ngrok.app` was already online.

## Diagnosis

No ngrok process was running on this VM. The ngrok API showed the endpoint held by a tunnel session from 3.149.191.121, a different cloud VM, while this VM's public IP was 52.14.104.140. A third VM had also registered `rose-cloud-44cb5599-bench-*` endpoints.

`cloud-build.sh` named the workspace `cloud-<first 8 chars of /etc/machine-id>` and kept any `.cloud-env` that already existed. Both files are baked into the environment snapshot: `/etc/machine-id` dates from 2026-05-05, and `.cloud-env` predates this VM's boot (17:53 against a 19:38 boot). So every VM cloned from the snapshot ran as `cloud-44cb5599`. Everything keyed by that name was shared across concurrent agents:

- the reserved ngrok domain, which failed this stack
- the `navi-agent-tasks-cloud-44cb5599` Temporal queue that `run.sh` derives, so one VM's worker could consume another VM's workflows

## Solution

`ensure_cloud_workspace_env` in `scripts/lib/workspace-env.sh` now owns `.cloud-env`. It records the kernel boot id (`/proc/sys/kernel/random/boot_id`), and when the file was written by another boot it mints a random `cloud-<8 hex>` id. Reruns within one boot keep the name. Native Conductor workspaces are still left alone. `cloud-build.sh` calls the helper instead of its inline machine-id logic.

`scripts/tests/workspace-env.test.sh`, which `/deploy` Step 4s runs, clones one baked `.cloud-env` into two instances with different boot ids. It asserts both get distinct names that also differ from the build's name, and that each keeps its name for the rest of its boot. Against the old keep-the-existing-file logic, the test fails with all three names equal to `cloud-07e444bf`. With the fix it passes. This VM was re-provisioned as `cloud-7e58e514`.

Each new instance reserves its own ngrok domain on first `run.sh`, as distinct machine-ids already did before snapshots (`rose-cloud-229cf4c4`, `rose-cloud-625aeb9e`, and others).

## Human feedback

None recorded.

## Reusable lesson

An identity derived from anything on disk is shared by every snapshot clone. Bind it to something the running instance owns, such as the boot id.
