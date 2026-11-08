# PR 1767 deletion-readiness closeout

Status: post-merge record. The committed `deletion-readiness.json` beside this file is the record of record for deletion readiness.

- Deployed PR: [#1767](https://github.com/Rose-Ai-Labs/rose/pull/1767) "deploy gates: report each gate's first failing test while it runs", branch `feat/gate-early-failure`, merged 2026-11-08T00:55:40Z as `2e0403fdf940e9ea4406348929ec0a0db8957fa5` (reviewed head `059cc72d317202669290c86c1d4b1364df007caf`). Records PR: this records PR.
- Deploy worktree: `/var/tmp/rose-base-measure` (prepared deploy worktree, idle at HEAD `059cc72d31` when archived; nothing ran there during the closeout). Object prefix `devbox-closeout-private/pr1767-059cc72d/` uses that HEAD.
- No credential, key, signed URL or secret value is in this record. Env files appear by name and variable count only.

## 1. Gate history

| Round / cycle | Head | Result |
|---|---|---|
| Round 1 | `18248b411e` | FAIL: 2 introduced (deploy-command-structural, frontend coverage) and 2 pre-existing (semantic tunnel, stale 56-Machine smoke ceiling, which left smoke incomplete); triage `evidence/triage/triage-round1.json` |
| Focused | `47646bab7f` | PASS for the repaired gates; smoke 12/13 PASS, agent-payment-abandonment SKIPPED-with-warning (`triage-r5.json`) |
| Focused + failed-gates smoke | `146110626b` | PASS; smoke 12/13 PASS, same warning (`triage-r7.json`) |
| Final pre-sync sweep | `146110626b` | all 16 gates PASS, `PIPELINE_VERIFY status=bound-staged exit=0` |
| First cycle after the main sync | `059cc72d31` | stopped at triage: the 11 other gates it ran PASS, smoke 13 UNVERIFIED (every job refused at preflight, 0 Machines) |
| Fresh cycle `deploy-pipeline-r2` | `059cc72d31` | **16/16 PASS**, `PIPELINE_VERIFY exit=0`, `DEPLOY_GATES PASS gates=16`; backend coverage 252/252; smoke 12/13 PASS, agent-payment-abandonment SKIPPED-with-warning (`triage-r10.json`) |

Round 1 failures and their fixes (each with a regression that fails on the old code):
- deploy-command-structural (introduced): the backend-coverage-sharded fixture copied `blackbox/run.ts` without the new `../helpers/gateProgress` module (MODULE_NOT_FOUND, reported early 22 s after the suite ended). Fix `1a8acac1da`.
- frontend-coverage-blackbox (introduced): the Vitest reporter imported types from `vitest/node` inside `tsconfig.app.json`, which changed jest-dom matcher resolution (TS2322 in `terminal-components.blackbox.tsx`), so `test:coverage` exited 2 before any test ran. Fix `93c17041f1` (types declared locally).
- semantic-stack (pre-existing on main): every deploy's gate VM derived the same reserved ngrok domain `rose-rose.ngrok.app` (ERR_NGROK_334 while another deploy held it). Fix `2c36501e57` (`BENCHMARK_SKIP_PUBLIC_TUNNEL=1`; no semantic spec uses a public origin).
- smoke (pre-existing): `reserve_worker_machine_slot` still defaulted the app Machine ceiling to the stale 56 after #1751 raised it to 300, refusing mass-agent's mandatory autoscaler at 66 Machines; the controller exited 1, which left the other 12 tasks UNVERIFIED. Fix `724a521275` (every default must agree).

Native cleanup proof fixes: round 1's verified smoke cleanup could not be reconciled because a 98 MB mass-agent `_batch/run.json` exceeded the 64 MiB receipt cap and fleet audits live in a linked worktree's git common dir (fix `47646bab7f`); the proofs then read fleet ownership registries from the git common dir, without which a retained registry passed as absent in a linked worktree (fix `146110626b`, found by the PR1768 deploy's independent review, with a negative control). Round 1's smoke cleanup reconciled: 0 of 15 owned clones left on Fly.

Sync with main: the merge of `origin/main` conflicted in `run-bench-fleet` and `cloudbench_dependency_sync_test.py` because PR #1747 had landed the identical 56→300 worker-ceiling fix with an equivalent test; main's side was taken (`059cc72d31`).

Why a fresh cycle reran all 16 gates: the first cycle's smoke campaign `bcb5368c…` started before the sync merge was pushed, so run-bench preflight refused every job ("requested benchmark commit 059cc72d31 is not fetchable from origin"): 13 UNVERIFIED, no fleet run directory, no Machine allocated. `native-cloud-cleanup-v1` has no layout for dispatched jobs without a monitor line (the gap PR1724 recorded), so that cycle's cleanup owner could not be reconciled and the cycle stayed at triage. A fresh cycle (`.context/deploy-pipeline-r2`) on the pushed `059cc72d31` reran every gate; the old state is archived unchanged (`cycle-r1`). Coordinator note: `evidence/cycle-restart-notes.txt`.

The AgentCard warning skip: `smoke/agent-payment-abandonment` failed natively on every smoke run of this deploy with the standing AgentCard sandbox release stall (the closed card's org transfer was `consumed` with `releasedCents=0`); under the standing user-approved warning policy the native row is SKIPPED (`docs/rca/cases/2026-10-02-agentcard-abandonment-closed-card-transfer-never-released.md`). It is a warning, not a pass.

Review: CodeRabbit returned "Review limit reached — usage spending cap" on all three reviewed heads (`18248b411e`, `146110626b`, `059cc72d31`); the review cycles were closed as `skipped` with `skip_reason=usage-cap` and the user agreed to skip. PR #1767 was **merged unreviewed**.

Production lanes at the merge commit (`evidence/production-lanes.json`, 2026-11-08T00:55:57Z–01:09:17Z): render PASS (live), vercel PASS (deployment 7629461884), mac-release PASS (release-mac-app run 42432014202), backend-probes PASS (`/health`, `/api/agents`, endpoint smoke, Render log clean), semantic PASS (chat-lifecycle-ratchet run 42432550023); fly, wmh, workflow-migration and agentcard SKIPPED-not-applicable. `scripts/deploy finish --outcome completed` ran; the factory ledger published 49 rows (`28f278b94a` on main).

## 2. What is preserved, and where

Private archives are AES-256-GCM framed gzip tars (`ROSE-PRIVATE-TAR-GCM-V1`) in the existing private R2 bucket `trace-archive`, uploaded as new objects only, each with an encrypted receipt sidecar (`<key>.receipt.aesgcm`). Per-archive gzip/manifest/sidecar hashes and frame counts are in [closeout-manifest.json](closeout-manifest.json).

| Archive | Object key (under `devbox-closeout-private/pr1767-059cc72d/`) | Files | Original | Stored | Ciphertext sha256 | Independent check |
|---|---|---:|---:|---:|---|---|
| deploy-state | `20261108T011523Z-deploy-state-0e974843cbe6.tar.gz.aesgcm` | 7,268 | 149.5 MB | 49.6 MB | `2873f4464b3f0f60a1d726cef24f034ea6dd925ff411d2ea5168f734ce1e9a62` | restore: 7268/7268 members, 0 bad |
| cycle-r1 | `20261108T011704Z-cycle-r1-b0837fe8f56b.tar.gz.aesgcm` | 20,942 | 412.8 MB | 144.7 MB | `08747077914efeb3f77a47d0970af1ccbc4a299c1f7a3370ae00a3c62eba372c` | stream: 20942/20942 members, 0 bad |
| cloud-final | `20261108T012208Z-cloud-final-f4e93003c7ab.tar.gz.aesgcm` | 1,630 | 1,140.3 MB | 291.3 MB | `bd581722e79a9a60c2e1eb0711b19dfb15850cd1657f2048f81e0bdd0f511af9` | stream: 1630/1630 members, 0 bad |
| cloud-e-86621f83 | `20261108T012847Z-cloud-e-86621f83-0dc290b1adf8.tar.gz.aesgcm` | 1,603 | 1,208.4 MB | 308.5 MB | `4cb1ed5070a5c4be5d72191c9145601676b76ec3b8ec5c0d12bd6a3bcdc74019` | stream: 1603/1603 members, 0 bad |
| cloud-e-200d9834 | `20261108T012847Z-cloud-e-200d9834-118a132ae583.tar.gz.aesgcm` | 1,686 | 1,293.8 MB | 335.2 MB | `8158bbbc6e5794e5d37a503a2142a1aebd7ebc11009bbc37b2d667343f3f80af` | stream: 1686/1686 members, 0 bad |
| cloud-e-573a4e3e | `20261108T012822Z-cloud-e-573a4e3e-42901fcc7039.tar.gz.aesgcm` | 1,505 | 1,140.7 MB | 295.2 MB | `ba3f4423c7901675c93a6e8b0339b1d27e6e47a876e6f3283559494ec6bf6786` | stream: 1505/1505 members, 0 bad |
| cloud-e-05e303b3 | `20261108T012757Z-cloud-e-05e303b3-c1c021ef2447.tar.gz.aesgcm` | 1,526 | 1,014.1 MB | 283.8 MB | `44c80931a74dc90a2d07c42f6607bc4626dabb78edd71b85e0453b1dce11bb90` | stream: 1526/1526 members, 0 bad |
| cloud-e-bcb5368c | `20261108T012342Z-cloud-e-bcb5368c-0c3a7d987cbd.tar.gz.aesgcm` | 171 | 0.7 MB | 0.2 MB | `2d3b4da900e7b42b11d03d90c6bb33436dd936e66a99c1d83174c0efe6b729a9` | restore: 171/171 members, 0 bad |
| bn-worktrees | `20261108T012201Z-bn-worktrees-a8b29c346dbd.tar.gz.aesgcm` | 543 | 2.3 MB | 0.7 MB | `56e376b130f4c5db9e935466acfe136207c2a7ed9e4d1b0fcb5bb3a097fbf6cf` | restore: 543/543 members, 0 bad |
| control | `20261108T013108Z-control-6a580d1060f4.tar.gz.aesgcm` | 98 | 42.9 MB | 4.9 MB | `5cbc60177ca4e126e2c99e28c06224304f86163500dba90a5ad63c4ea6ba2c54` | restore: 98/98 members, 0 bad |

Contents:
- `deploy-state`: the deploy worktree `.context` minus the sets below: `deploy-pipeline-r2` (final READY cycle, `production-lanes.json`, `production.json`, production logs), `deploy-runs`, `deploy-pr.json`, `deploy-merged.json`, `deploy-collect.json`, review cycle ledger and dispositions, approval batch, `factory-events.jsonl`, `early-probe`, `deploy-structural`, `trace-archive-outbox`, `deploy-worktree.env` (paths only); plus `.llm-dumps` and the coordinator scratch `/var/tmp/deploy-early` (triage reports, gate and review logs, cycle snapshots, notes).
- `cycle-r1`: `.context/deploy-pipeline`: the first cycle (rounds on 18248b411e, 47646bab7f, 146110626b and 059cc72d31), stopped at triage, kept unchanged as evidence.
- `cloud-final`: `.context/deploy-cloud/bc470be0…`: the final smoke campaign (fresh cycle, 059cc72d31).
- `cloud-e-86621f83`: `.context/deploy-cloud/86621f83…`: round 1 smoke (18248b411e).
- `cloud-e-200d9834`: `.context/deploy-cloud/200d9834…`: focused smoke (47646bab7f).
- `cloud-e-573a4e3e`: `.context/deploy-cloud/573a4e3e…`: focused + failed-gates smoke (146110626b).
- `cloud-e-05e303b3`: `.context/deploy-cloud/05e303b3…`: final pre-sync sweep smoke (146110626b).
- `cloud-e-bcb5368c`: `.context/deploy-cloud/bcb5368c…`: first-cycle smoke on 059cc72d31, every job refused at preflight.
- `bn-worktrees`: `.context` of the bottleneck follow-up worktrees `/var/tmp/bn-review-github`, `bn-fly-bench`, `bn-prod-descendant` (other `bn-*` worktrees have none).
- `control`: the closeout tools, set listings with per-member sha256, secret-scan summaries (pattern names and counts only), receipts, deletion-check rehearsals, env-name parity and `unarchived-credential-bearing.json`.

The deploy worktree's files were listed in place (the worktree was idle; ~10 GB of evidence against ~12 GB free disk ruled out snapshot copies); the uploader refused any member whose size, mtime or sha256 differed from its listing.

## 3. Not archived, and why

- Reproducible: `node_modules/`, `agents/venv`, `__pycache__`, `.pytest_cache`, `.context/tsbuildinfo/`, `.context/trace-archive-locks/`, controller `*.lock` files, `*.env.cloudbench-upsert.lock`, the generated `docs/rca/INDEX.md` (`python3 scripts/rca_archive.py reindex`).
- `.context/fly-ab/` of the deploy worktree: owner-declared unneeded and credential-bearing (PR 1751 closeout, section 2); unchanged since.
- Env files (names only): the deploy worktree's `agents/.env`, `back-end/.env`, `front-end/.env`, `mac-app/.env` are symlinks to the canonical checkout's files; every variable name of each is present with a value in `dvb-onbox env list` (checked 2026-11-08; value parity is not verifiable from the list). The `bn-*` worktrees' `agents/.env` and `back-end/.env` are one-variable stubs whose name is also managed.
- Credential-shaped content: 113 files (3,048,335,464 bytes) were left OUT because the PR 1751 broadened scanner found high-confidence patterns in them (base64_wrapped_credential 261, github_token_b64_field 247, jwt 4, pan_like_luhn 120, sk_token 1, upstream_api_key_field 72); by set: `deploy-state` 2, `cycle-r1` 3, `cloud-final` 22, `cloud-e-86621f83` 22, `cloud-e-200d9834` 22, `cloud-e-573a4e3e` 20, `cloud-e-05e303b3` 21, `cloud-e-bcb5368c` 1. They are the six fleet `shared-inventory/machines.json` files and `/var/tmp/deploy-early/bench-machines.json` (base64-wrapped GitHub token field; one inventory also holds an `sk-` key), per-run `.upstream.json` files (upstream API key field), backend coverage `server-shard2.log` files (one JWT each) and the mass-agent run records and driver logs (brand-structured Luhn-valid numbers). Names, sizes and pattern names (never values) are in `unarchived-credential-bearing.json` of the `control` archive. They exist only on this devbox until the user or owner declares them unneeded or approves archiving them as opaque ciphertext. The task outcomes they describe are in the Hub and in the ledger rows below.

## 4. Benchmark history

Fresh lean worktree of `origin/main` (`28f278b94a`), branch `records/pr1767-closeout`:
- `scripts/benchmark-history-backfill.py` dry run, then `--write`: hub found 24,987, duplicate 7,111, unbound 17865, never-merged 7, superseded pre-merge 2, **added 2** (two `fly-measure-083003` rows of merged code, 2026-11-06); branch scan found 1,806 (1,505 never merged, 301 superseded). 2 attempt rows and 2 duration rows written.
- This deploy's final smoke (`deploy-bc470be0…`, source `059cc72d31`): the tool reports its 13 Hub rows as UNBOUND because the Hub records no `code` identity for them. The campaign's own `result.json` binds `source.head` `059cc72d31`, an ancestor of the merge, so the 13 rows were appended with the tool's own `hub_ledger_row()` (identical row format, `backfill_source: hub:cloud-fleet`): **13 attempt rows** (12 passed, agent-payment-abandonment failed with the AgentCard release stall reason) and **12 duration rows**. Earlier smoke campaigns of this deploy ran superseded pre-merge heads and stay out under the latest-only rule.
- `python3 scripts/benchmark-history-latest-only.py --base origin/main --check`: exit 0.

## 5. Restore without this devbox

Use a project devbox (managed env delivers `agents/.env`, `back-end/.env` and `.context/pr1634-archive-recovery.env`, key fingerprint `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`; never print them). From a checkout containing the recipe and adapter, for each archive's `receipt_sidecar_key`:

```bash
mkdir -m 700 ../pr1767-private-recovery
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key '<receipt_sidecar_key>' --output ../pr1767-private-recovery/<label>.receipt.json
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py <same options> \
  restore --receipt ../pr1767-private-recovery/<label>.receipt.json --destination ../pr1767-private-recovery/<label>
```

Members are named `pr1767-closeout-staging/...`: `worktrees/<name>/` is a worktree path, `var/tmp/` the machine path, `control/` the closeout tooling and listings.

## 6. Verification performed

- Every archive: full download with per-frame authentication, stream hashes and every member hash against the in-archive manifest (the recipe's own `verify`), then an encrypted receipt sidecar written and read back authenticated.
- Independent check with the unchanged PR 1634 adapter: `fetch-receipt`, then either a full restore into an empty directory (`deploy-state`, `bn-worktrees`, `cloud-e-bcb5368c`, `control`) or, for the large smoke sets where a restore would not fit on disk, a streamed pass through the recipe's frame authentication; both compare every member's sha256 and size to the hash taken from the source before upload. 0 differences.
- Secret scan: the PR 1751 broadened scanner (key shapes, JWTs, bearer tokens, Fly tokens, Luhn-valid card numbers, base64-wrapped credentials, sensitive field names) ran on every staged file; `deploy-state`, `cycle-r1` and `cloud-final` were rescanned on the exact listed bytes immediately before upload; for the other sets the staging scan is bound to the uploaded bytes by the per-member sha256. Pattern based: it cannot prove the absence of every secret.
- Not verified: bucket public-access settings, env value parity with managed env, anything created after the archive cutoffs.

## 7. Deletion readiness

`deletion-check` ran from the deploy worktree with `DEPLOY_TEST_CYCLE_STATE_DIR=/var/tmp/rose-base-measure/.context/deploy-pipeline-r2`, `--manifest` this directory's `manifest.json` and `--receipt` this directory's `deletion-readiness.json` (absolute paths in the records worktree; the deploy worktree stays on `feat/gate-early-failure`, so the receipt is committed here rather than there). Verdict: **PENDING** (open items: n/a).

[manifest.json](manifest.json) gives every ignored path of every worktree a disposition. The deploy worktree's own paths are relative globs; every other worktree is matched by absolute path. Paths of `/home/boxes/rose`, `rose-agentcard-cloud`, `rose-blacksmith`, `rose-blacksmith-int` and `rose-deploy-measure` that have not changed since the PR 1751 closeout's final archive cutoff (2026-11-07T16:24Z; no file newer) carry that closeout's dispositions and archive bindings, as do the twelve local-only branches and the stash (`branch:`/`stash:` entries bound to their unchanged tips).

Processes: the deploy-v2 thread's Claude session pid 3007638 (cwd `/home/boxes/rose`), which blocked the PR 1751 receipt, has exited. This devbox's default `codex app-server` pid 1464599 still has cwd `/home/boxes/rose`; it is not in the deploy worktree and does not block this check.

## 8. Open follow-ups

- **Bottleneck follow-up deploy**: the `bn-*` worktrees' work is pushed and combined on `bottleneck/ledger-merge` (`5f1f1f4223`); it needs its own `/deploy`.
- **Adapter should refuse an unpushed HEAD**: the smoke adapter launched a paid-fleet campaign for a commit origin did not have; every job was refused at preflight and the cycle could not recover. The cloud gate should check that HEAD is fetchable from origin before dispatch.
- **Native cleanup proof layout for preflight-refused jobs**: `native-cloud-cleanup-v1` cannot reconcile dispatched jobs that never wrote a monitor line (also recorded by PR1724).
- **In-flight fix registry across devboxes**: PR #1747 and this deploy fixed the same stale 56-Machine ceiling independently; a cross-devbox registry of in-flight fixes would have avoided the duplicate work and the sync conflict.
- **AgentCard unreleased funds**: four native stall rows in this deploy, each `transferredCents: 4396`, `releasedCents: 0`, status `consumed`, `livemode: false` (test mode): org transfers `owt_bf27b09a21db062cc1287f3e` (round 1), `owt_99bf0b4f86e15b1895657a34` (47646bab7f), `owt_ecefafabcff769eef9c9bcd1` (146110626b), `owt_93563a431ee467fc132858de` (final, 059cc72d31) — **17,584 cents ($175.84) unreleased in total, $43.96 per run**. The pre-sync sweep campaign `05e303b3…` did not run this task; `bcb5368c…` never started it.
- **deploy-v2 thread session pid 3007638**: it held `/home/boxes/rose` during the PR 1751 check; it has since exited, so the PR 1751 receipt's process items no longer apply (rerun that check from `/home/boxes/rose` to certify it).
- **63 old unattached Fly volumes** (~2,716 GB, ~$407/month), reported by the deploy coordinator; none belong to this deploy. Destroying them is the user's decision; nothing was touched.
- **Credential-bearing files** listed in section 3 stay on this devbox pending the user's or owner's decision.
