---
id: 2026-07-15-warm-image-baked-deps-fingerprint-mismatch-fatals-before-start-barrier
date: 2026-07-15
title: Cloud smoke died before the start barrier because the warm Fly image's baked node_modules did not match the branch's dependency fingerprint
surface: infra
component: cloudbench-fleet
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Fresh storage selects an incompatible immutable /app dependency image while bypassing refreshed volume snapshot; sync-deps.sh:400-413 detects the mismatch
symptoms:
  - "isolated runner exited before synchronized start barrier (0/N ready)"
  - "dispatch status='failed' with actual=[] and every task status=None"
  - 'run_benchmark.py --ci exits 1 with "no report-card.json produced"'
  - 'live report-card stuck at status:"queued" / run_id:"starting"'
  - "FATAL: warm image/volume JavaScript dependencies do not match the checked-out ref"
tags:
  - cloudbench
  - fly
  - dependencies
  - warm-image
  - predeploy-smoke
sources:
  - memory:project_cloudbench_warm_image_dep_sync
  - PR #1662
  - commit 72a8bd7bf7e3a92b5717d13d617c2954bf453fca
  - commit e35e0bd6e4bcec35998bf13020cc3a0bf89707da
  - fleet run 20261102-232738-1139385
  - task 01fccf7d55714e55bbee3e30525f74f5
repro: none-recorded
status: open
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

## Recurrence — November 2, 2026

PR1662 focused request 6a2cc539afc44cd19842069affd4f029, frozen e35e0bd6e4bcec35998bf13020cc3a0bf89707da (digest abc77610583734e169f183a8adaabb6599fa81c4862fadbd7c42db99f588e6dc), retained all17 original checks. Native N2 infra canary run20261102-232738-1139385 was owned by campaign job r001-j0003. Both guests verified exact e35, injected env digests and repaired independent provider contract backend=tilion worker=kernel, then failed at dep_sync before service/task execution. Both native exits were1 with cleanup_ack1 and no current run artifact. This is separate from the earlier provider-contract defect and repaired PG15 fixture prerequisite.

The controller accepted the proven Node fingerprint 4ef2db9dda6bdd37cca1b2d6bd11f5cc8181591a26b4a1fd5cc0447d615d12f9, Python9d08ed65778213690792a290d583b22aefd1328a07740814846eafbec59f538e and snapshot vs_yN5ma3O2VJGhGypQpe6n. That snapshot was produced by the native c13 central refresh after rebuilding /data/repo and quiescing the donor. However, both canary catalog entries were REAL and the unchanged default FRESH_VOLUMES=1 selected fresh storage. Their native primary logs say mode=fresh; the native owned Volume create omits snapshot-id. Matching snapshot metadata therefore did not establish dependency compatibility for the actual fresh-volume consumers. Those guests use /app from immutable image digest9961d27adc9e9960d3f472d96540d93934a922c21484982d31849be9ff6d2aae instead of the refreshed /data snapshot.

The literal native inequality guard proves that both the installed marker and immutable donor fingerprint differ from required4ef2. Exact actual marker and donor hash were not captured and remain UNKNOWN; no new provider query was made. Do not infer the image hash from historical metadata. Native dependency guards remain strict.

Gate: NOT_INTRODUCED for this native dependency-source failure compared with actual current-main merge-base72a8bd7bf7e3a92b5717d13d617c2954bf453fca to e35. Main72a8, c13 and e35 have identical tracked JS dependency inputs and fingerprint4ef2; fleet and dependency-sync code are byte-identical across these revisions. Older basebf92cbd98ab436af20f9a8d647c32e748c67e93a has fingerprint977c7ed6ff5f489e0b7b8822af62b9a924fb6514916a1fba7cdb4747d6dc8de4. The changed backend dependency is jpeg-js0.4.4 and eight lockfile lines inherited from main commit401714255, not a dependency change in the provider repair. No baseline whole-smoke PASS is asserted.

Private controls under /var/tmp/pr1662-e35-dependency-sync-rca execute the actual unchanged native storage selection and volume-create functions: main/e35 fresh selects no snapshot, while existing snapshot mode includes the exact snapshot ID. Actual unchanged sync-deps on main/c13/e35 rejects the same authentic historical-manifest donor, and matching-marker controls pass. The historical donor is a controlled input, not an assertion about the actual image contents. Matching-marker controls prove branch selection and strict comparison, not installed packages or benchmark success.

The earlier snapshot refresh did not hold for this occurrence because it updated /data, while fresh REAL consumers read immutable /app. Required preparation is a compatible native dependency-image build with an independently verified publication/digest receipt, followed by parent-owned supported setup at a terminal, stopped-donor/shared-app-lock boundary. Prebuilt WARM_IMAGE_REF setup bypasses the publisher: preserve its independent image receipt. Setup stages full independently verified environments, activates the image with skip-start only on stopped donor/declared stopped pool (active pool skipped), then starts/prepares donor, clones/fetches repo and parks donor; preserve the entire transaction. The parent began the unchanged benchmark-only native image build; no image activation or repaired dependency runtime result is claimed here. Repeating only --refresh-deps cannot update immutable /app. Tasks, assertions, concurrency, timeouts, provider limits and production configuration remain unchanged.

Campaign1/17 infra stop at23:36:20.560008Z preserves one preflight failure,15 started sibling cancellations143 and one never-started member separately. All17 task outcomes remain UNVERIFIED. Saved native audits for18 controller runs report provider-teardown-verified; all16 recorded scheduled controller PIDs are absent. Only two fresh entries exist: machines85d3eea4514378 /862e70fe5e4428 and volumesvol_4oj805dz5yjqjpxr /vol_vp2eygx5y5oqyky4 are destroyed-provider-retained, not proven absent. The viewer remains retained-exact-owner-transfer-required. Adapter cleanup_complete=false and outer lingering_group=true remain preserved. A second native canary233613-1425174 was cancelled143 with no fresh audit entries. No provider outage/credit exception or completed operational repair is asserted.

## Human feedback

None recorded.

## Reusable lesson

When cloud smoke reports "0/N ready at the start barrier", read the per-task
`fleet-child.log` for a pre-barrier dep-fingerprint FATAL and rebuild the warm
image — a branch that changes dependencies invalidates the baked donor image.


## Round21 recurrence: fresh volumes after verified source patch

On frozen source `460e026e0f08d2ab65cbac836084c972eab3b021`, both original
canary drivers applied and verified whole-workspace patch
`231a01e79e1c19db68624f7010d03f2382264adbb1a6be39904ff5b3321e3fed`,
then failed at `STEP dep_sync` before the barrier or task execution. Their
primary receipts record fresh volumes and the immutable image's `/app` donor;
the accepted `/data` snapshot therefore did not establish these guests'
dependency compatibility.

The required Node fingerprint is
`23c8518fce516269d1a9d325518c043c1bb5ac0d2c716ad7aab11e68f7661a6d`;
the required Python fingerprint is
`9d08ed65778213690792a290d583b22aefd1328a07740814846eafbec59f538e`.
The exact old donor and installed-marker hashes are **UNKNOWN**; the native
inequality guard establishes the mismatch but did not log those values.

A matching image, digest
`f7b491fb57970add133cc9108ea13ebbf6e3149e3b863cea187d3f9d37db9582`,
was published from source `460e026e` in 264 seconds. It has **not been activated**,
and publication supplies no runtime acceptance, maintenance authority, cleanup
credit or cloud gate pass. Original failures and financial/native debts remain.

Evidence: `.context/cli-nov05-review/round21-dependency-rca.json` and
`.context/cli-nov05-review/round21-image-build/cloudbench-image-build.json`.
