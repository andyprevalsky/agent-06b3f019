---
id: 2026-07-15-warm-image-baked-deps-fingerprint-mismatch-fatals-before-start-barrier
date: 2026-07-15
title: Cloud smoke died before the start barrier because the warm Fly image's baked node_modules did not match the branch's dependency fingerprint
surface: infra
component: cloudbench-fleet
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/cloudbench-sync-deps.sh:88-94 — FATALs when the branch JS dep fingerprint differs from the baked donor image
symptoms:
  - "isolated runner exited before synchronized start barrier (0/N ready)"
  - "dispatch status='failed' with actual=[] and every task status=None"
  - 'run_benchmark.py --ci exits 1 with "no report-card.json produced"'
  - 'live report-card stuck at status:"queued" / run_id:"starting"'
tags:
  - cloudbench
  - fly
  - dependencies
  - warm-image
  - predeploy-smoke
sources:
  - memory:project_cloudbench_warm_image_dep_sync
repro: none-recorded
status: fixed
---

## Problem

`scripts/run-predeploy-cloud` failed for any branch that changed
`back-end/package.json` / `package-lock.json` (or `agents/requirements.txt`).
Cloud smoke reported `dispatch status='failed'`, an empty `actual=[]` task set,
every task `status=None`, and the poller said `isolated runner exited before
synchronized start barrier (0/N ready)`. The per-task `fleet-child.log` showed
the box booting ssh-ready and then `run_benchmark.py --ci` exiting 1 with "no
report-card.json produced", with the live report-card frozen at
`status:"queued"` / `run_id:"starting"`.

## Diagnosis

Cloud boxes git-sync branch **code** per run but take their **dependencies** from
the baked warm Fly image (`/app`), rsync'd onto `/data/repo`.
`scripts/cloudbench-sync-deps.sh:88-94` compares the branch's JS-dependency
fingerprint (`cloudbench_node_dependency_fingerprint` over package.json dep
fields + package-lock.json, in `scripts/lib/cloudbench-env.sh`) against the donor
image and FATALs on mismatch — before the synchronized start barrier, which is
why the failure reads as "0/N ready" rather than as a dependency error. If the
donor image predates a dep the branch added (here `@modelcontextprotocol/sdk`,
added to back-end for AgentCard MCP), sync-deps has nothing to rsync and hard
exits.

## Solution

The prescribed fix — not a workaround — is to rebuild the warm image so its baked
deps match the branch:
`CONDUCTOR_PORT=3001 bash scripts/run-bench-cloud --setup`. That builds and pushes
a new keep-alive image via Fly's classic remote builder
(`Dockerfile.cloudbench-warm`, ~966MB context, ~15-20 min, 3 retries) baking the
current working-tree deps, then `activate_owned_machine_images` repoints the warm
source (`cloudbench-warm`, id `683e47df5094d8`) and the pool; it is idempotent
for the existing volume/machine. If the remote builder truly fails (wireguardless
h2c 500), fall back to a local
`docker build --platform linux/amd64 -f Dockerfile.cloudbench-warm`, push to
`registry.fly.io/navi-whisper-lux-bench:<label>`, and re-run `--setup` with
`WARM_IMAGE_REF=<that>`. Because the fingerprint requires an exact match, a
rebuilt image matches exactly one dep-set: rebuild for the branch pre-merge, and
after merge main carries the dep so the image stays valid — other in-flight
branches without the dep will fail cloud smoke until they rebase.

## Human feedback

None recorded.

## Reusable lesson

When cloud smoke reports "0/N ready at the start barrier", read the per-task
`fleet-child.log` for a pre-barrier dep-fingerprint FATAL and rebuild the warm
image — a branch that changes dependencies invalidates the baked donor image.
