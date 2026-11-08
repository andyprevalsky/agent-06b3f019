# PR 1784 deletion-readiness closeout

Status: post-merge record. The committed `deletion-readiness.json` beside this file is the record of record for deletion readiness.

- Deployed PR: [#1784](https://github.com/Rose-Ai-Labs/rose/pull/1784), branch `deploy/bottleneck-fixes`, merged 2026-11-08T20:42Z as `617bb467fd75e3770d686e17aab9e519bded0f37` (reviewed and merged head `8edce49e3b4ab656967e9b31fdbd62046b6a9aae`). Records PR: this records PR.
- Coordinator worktree: `/var/tmp/rose-base-measure` (idle at HEAD `8edce49e3b` after `scripts/deploy finish --outcome completed`; nothing ran there during the closeout except `deletion-check`). Object prefix `devbox-closeout-private/pr1784-8edce49e/` uses that HEAD.
- No credential, key, signed URL or secret value is in this record. Env files appear by name and variable count only.

## 1. Gate history

Source: the coordinator's deploy history (`/var/tmp/deploy-early/notes-bn.txt`, archived in `deploy-state`) and each cycle's `cycle.json` (archived). Triage reports are in `evidence/triage/`.

| Round / cycle | Head | Result |
|---|---|---|
| bn round 1 (`deploy-pipeline-bn`) | `e0dfb8b88c` | FAIL: 4 INTRODUCED. deploy-command-structural and cloudbench-controller (fixtures copied without `history_ledger.py`), agents-coverage benchmark domain (same fixture), semantic-stack (Cerebras quota probe polled HTTP 403 for its full 3600 s budget, 67 min gate). Fixes `bfd0b4d1cd`, `7e3c01543c`, `eb5a5460c3`, `11ab61c131`; the refresh was refused because `eb5a5460c3` changed semantic-stack's execution contract, so a fresh cycle reran all 16 gates (`triage-bn1.json`) |
| bn2 | `11ab61c131` → `b698aa8dde` | 1 INTRODUCED: deploy-test-github capacity fixture had no origin, so this branch's unpushed-HEAD refusal (`9b9a4771b0`) exited 2; fix `b698aa8dde` (`triage-bn2.json`). Cycle went stale: the managed env files were rewritten at 03:50:55Z mid-round (GitHub App keys); its focused smoke stopped because the devbox could not allocate 15 x 768 MB teardown reserves (15 runs teardown-verified, 0 owned clones) |
| bn3 | `d8c5bb04bd` | 11 non-smoke gates PASS; smoke 12 PASS + 3 NOT_INTRODUCED payment failures: test-shop guest shutdown HTTP 000 on one 3 s POST (fixed `60c129a2fc`), abandonment AgentCard 401/429 bursts bypassed the stall classifier (repair B), new-user-journey Stripe ZIP absent (repair C). Smoke receipt stayed incomplete (test-shop run had no local teardown dir) |
| bn4 | `60c129a2fc` | READY; smoke abandonment native SKIPPED with the standing AgentCard release stall (`triage-bn4.json`). Merge then waited on the PR 1770 overlap and the Fly hold of the PR 1795 cutover; `main` moved |
| bn5 | `ec2e72f15a` (after sync) | quick typescript FAIL: stale generated Prisma client after the sync (main's `CodeSession.closingTaskId`). Durable fix `f8a33aa856`: `scripts/deploy gates` runs `ensure-prisma-client.sh` before workers, plan and cycle |
| bn6 | `f8a33aa856` | quick 4/4 + 11/12 PASS; smoke FAIL in 2 s, "historical custody: missing canonical custody locator": PR 1770's `admission()` required the default `.context/deploy-pipeline/cycle.json` locator, which held a stale PR 1767 cycle (moved aside to `deploy-pipeline-pr1767`, rename only); repair D |
| bn7 | `f8a33aa856` | quick + 11 non-smoke PASS; smoke INFRA STOP 1/15 at r001-j0010 (agent-payment-idempotent-abandonment): the AgentCard org MCP throttle ("Too many requests") in `setup-benchmark-payment.ts` was not retried by the float layer. Campaign cancelled, all 15 UNVERIFIED. Fix `d940210a92` (typed `agentcard_org_mcp_rate_limited` retry with jittered 7.5-22.5 s waits inside the existing 4-attempt / 65 s caps; regression fails on old code 5/5) |
| bn8 (canonical cycle) | `d940210a92` | READY: smoke 14/15 PASS + abandonment native SKIPPED (standing release stall; `triage-bn8.json`) |
| bn9 / bn10 (same canonical cycle) | `8edce49e3b` (sync with main `81543cf315`) | refresh with the historical custody proof, then bn10: backend-coverage-blackbox FAIL in benchmark-share (fixture cleanup DELETE 404 after a 201 upload), NOT_INTRODUCED: both coverage shards share one local Hub folder while `withIndexLock` is a per-database advisory lock, so shard 2's poller rewrote `index.json` in the same millisecond and dropped shard 1's run (local repro 214/935 deletes 404, 0/1885 with per-shard dirs; `/var/tmp/rca-bshare-repro`, `/var/tmp/rca-bshare-logs`). Post-merge repair E, resolved in the cycle. Smoke 14/14 PASS; agent-payment-abandonment held under no-remint custody and did not run (`triage-bn10.json`). Cycle READY, `complete` passed |

Review: CodeRabbit returned "Review limit reached — usage spending cap" on every reviewed head (`e0dfb8b88c`, `60c129a2fc` unavailable, `d940210a92`, `8edce49e3b`); the cycles closed `skipped` with `skip_reason=usage-cap`. PR #1784 was **merged unreviewed**.

Production lanes at the merge commit (`evidence/production-lanes.json`, 20:42:30Z–21:02:21Z): render PASS (live), fly PASS (deploy-agents run 42521463072, job `603a1c0f…` SUCCEEDED + `monitor --verify`; carries PR 1744 `8dbb27dbfc` and PR 1747 `37f705cd8d` by ancestry), vercel PASS (deployment 7641597415), mac-release PASS (release-mac-app run 42521496492), backend-probes PASS (`/health`, `/api/agents`, endpoint smoke, Render log clean), workflow-migration PASS, semantic PASS (chat-lifecycle-ratchet run 42522470865); wmh SKIPPED-not-applicable. **agentcard FAIL pre-spend**: the production payment identity `00000000-0000-4000-8000-000000000107` is not provisioned (`stripeLivemode=False`); the preflight refuses before any card is issued. External exception: only the user can provide a dedicated KYC'd live AgentCard cardholder and save a live card through the hosted Checkout link. `scripts/deploy finish --outcome completed` ran.

Cleanup: bn7's 10 retained owners (guests that did not ack cleanup after the cancel) were reconciled with `scripts/run-bench --recover-stale-owner` (exit 0), 10/10 Machines destroyed; bn8 15/15 and bn10 16/16 Machines destroyed. The sealed read-only `teardown-ownership` remnants under `.context/deploy-cloud` are kept unchanged (archived in `cloud-bn7`). The flyctl agent (pid 2780532) started by the coordinator's 12:08Z Machine checks was stopped by the coordinator by exact PID before the final check.

## 2. What is preserved, and where

Private archives are AES-256-GCM framed gzip tars (`ROSE-PRIVATE-TAR-GCM-V1`) in the existing private R2 bucket `trace-archive`, uploaded as new objects only, each with an encrypted receipt sidecar (`<key>.receipt.aesgcm`). Per-archive gzip/manifest/sidecar hashes and frame counts are in [closeout-manifest.json](closeout-manifest.json).

| Archive | Object key (under `devbox-closeout-private/pr1784-8edce49e/`) | Files | Original | Stored | Ciphertext sha256 | Independent check |
|---|---|---:|---:|---:|---|---|
| deploy-state | `20261108T211634Z-deploy-state-9c1ff96d6b3f.tar.gz.aesgcm` | 2,911 | 68.9 MB | 16.8 MB | `2fa39f76433915e9042847f184b3697585d390f29d797c31f184fef7ed7a3c3a` | restore: 2911/2911 members, 0 bad |
| cycle-final | `20261108T211313Z-cycle-final-51f43e77d9ff.tar.gz.aesgcm` | 14,714 | 592.5 MB | 141.7 MB | `a080a86365f8e514701ad2e2de85de4613dbc7bcbe5ae0f5db9334af32ca6990` | stream: 14714/14714 members, 0 bad |
| cycles-bn-a | `20261108T211313Z-cycles-bn-a-cc263e0f5469.tar.gz.aesgcm` | 20,985 | 418.9 MB | 145.4 MB | `5d4ee9b7a05e4dd0b266dd145dce9292ce2640a27a28e4b27c6893c60585f461` | stream: 20985/20985 members, 0 bad |
| cycles-bn-b | `20261108T211313Z-cycles-bn-b-613ae8a6a825.tar.gz.aesgcm` | 20,187 | 408.3 MB | 140.7 MB | `de7d95419a44ff99d996b5662a75a642f63ec3e0609188892397d9b0a0990e8d` | stream: 20187/20187 members, 0 bad |
| cloud-bn10 | `20261108T211728Z-cloud-bn10-28e42ccd11fb.tar.gz.aesgcm` | 1,696 | 1,249.1 MB | 318.2 MB | `75498202bfdca390a4d8c838cb8e133ee9ddfb64fd9a8703e28d5f52c05ccf18` | stream: 1696/1696 members, 0 bad |
| cloud-bn8 | `20261108T211728Z-cloud-bn8-652c9817d884.tar.gz.aesgcm` | 1,791 | 1,480.6 MB | 338.1 MB | `69f04c818776b819b76e2d9ceb15189e1697aad4cbcf178477507006a355dbdf` | stream: 1791/1791 members, 0 bad |
| cloud-bn7 | `20261108T211313Z-cloud-bn7-bcf6d14738d1.tar.gz.aesgcm` | 3,869 | 359.9 MB | 113.7 MB | `2e109ec73cd61310684c47dabed6763708b9d0f11beb79d1b333a2d2259b9ec7` | stream: 3869/3869 members, 0 bad |
| cloud-tarball | `20261108T211415Z-cloud-tarball-29c2b0389b1f.tar.gz.aesgcm` | 5,798 | 2,928.2 MB | 699.2 MB | `9dbfb942dfa3f7e74d54ad16c5133e23805daa2478e3a126570fa96c1d7d5975` | stream: 5798/5798 members, 0 bad |
| git-preview | `20261108T211634Z-git-preview-c84a3de682d7.tar.gz.aesgcm` | 3 | 0.0 MB | 0.0 MB | `06df43219912b829806db0a8e1c823d5edccb4800aad1fac13506d81701e2bdf` | restore: 3/3 members, 0 bad |
| control | `20261108T214101Z-control-b346d907beed.tar.gz.aesgcm` | 100 | 83.1 MB | 9.6 MB | `1e48f0de7c0217591063a2a7b086bbd54ed8cf6ba544387dc1a7fc2fecdd5661` | restore: 100/100 members, 0 bad |

Contents:
- `deploy-state`: the coordinator worktree `.context` minus the cycle and smoke sets below (deploy-runs, deploy-pr/merged/collect, review-cycle ledger and dispositions, approval batch, factory-events.jsonl, early-probe, deploy-structural, trace-archive-outbox, hub-poller-runs, CodeRabbit re-request record, deploy-worktree.env), `.llm-dumps`, `agents/.context`; a snapshot of the coordinator scratch `/var/tmp/deploy-early` (notes-bn.txt deploy history, triage reports, cycle snapshots, gate/review/merge/production logs, handoff prompts, bn7 recovery logs, and the `.sha256`/`.entries.txt` manifests of the local smoke tarball); RCA evidence `/var/tmp/rca-bshare-repro`, `/var/tmp/rca-bshare-logs`; `/var/tmp/bn-ledger-merge/.context` and `/var/tmp/bn-ledger-merge-scratch`; `/home/boxes/rose/.context/deploy-scorecard-latest.json`.
- `cycle-final`: `.context/deploy-pipeline`: the canonical cycle that carried the merge (bn8 on d940210a92, refreshed to 8edce49e3b, bn10 READY), `production-lanes.json`, production logs.
- `cycles-bn-a`: `.context/deploy-pipeline-bn`, `-bn2`, `-bn3` (rounds on e0dfb8b88c, 11ab61c131/b698aa8dde, d8c5bb04bd).
- `cycles-bn-b`: `.context/deploy-pipeline-bn4` … `-bn7` (60c129a2fc, ec2e72f15a, f8a33aa856 twice).
- `cloud-bn10`: `.context/deploy-cloud/5a68051c…`: final smoke campaign (bn10, 8edce49e3b).
- `cloud-bn8`: `.context/deploy-cloud/d024e4b0…`: bn8 smoke campaign (d940210a92).
- `cloud-bn7`: `.context/deploy-cloud/b6af1450…`: bn7 smoke campaign (INFRA stop), plus the sealed read-only teardown-ownership remnants of the 9 earlier namespaces.
- `cloud-tarball`: the 9 earlier smoke namespaces whose raw files the coordinator removed at 10:55Z after packing them into `/var/tmp/deploy-early/archive/pr1784-deploy-cloud-20261108.tar.gz`: repacked member by member (tarball sha256 checked against its `.sha256`; every member hash cross-checked with the pre-archive manifest).
- `git-preview`: thin `git bundle` of the local-only `preview/pr1784-x-pr1770` (3 commits, never pushed) with `tip.txt` and `commits-on-no-remote.txt`.
- `control`: the closeout tools, set listings with per-member sha256, secret-scan summaries (pattern names and counts only), receipts, deletion-check rehearsals, env-name parity, cycle identity check against PR 1767, backfill reports, final smoke rows and `unarchived-credential-bearing.json`.

Carried, not re-uploaded: `.context/deploy-pipeline-pr1767` (PR 1767's first cycle, moved aside at 11:24Z) and `.context/deploy-pipeline-r2` (PR 1767's final cycle) are byte-identical to what the PR 1767 closeout archived (`cycle-r1` and `deploy-state` under `devbox-closeout-private/pr1767-059cc72d/`): every archived member's sha256 matches, and the only other files are the same cache directories and credential-bearing files that closeout left out.

The coordinator worktree's files were listed in place (the worktree was idle); the uploader refused any member whose size, mtime or sha256 differed from its listing. `/var/tmp/deploy-early` was still being written by the coordinator, so a private snapshot (`rsync -a`, mtimes kept, 21:15Z) was archived under its original path names.

## 3. Not archived, and why

- Reproducible: `node_modules/`, `agents/venv`, `__pycache__`, `.pytest_cache`, `.context/tsbuildinfo/`, `.context/trace-archive-locks/`, controller `*.lock` files, `*.env.cloudbench-upsert.lock`, the generated `docs/rca/INDEX.md` (`python3 scripts/rca_archive.py reindex`).
- `.context/fly-ab/` of the coordinator worktree: owner-declared unneeded and credential-bearing (PR 1751 closeout, section 2); unchanged.
- Env files (names only): the coordinator worktree's `agents/.env`, `back-end/.env`, `front-end/.env`, `mac-app/.env` are symlinks to the canonical checkout's files; every variable name of each canonical env file (96, 160, 3, 7 variables; plus `research/.env`, `.env.npm`, `agents/.env.benchmark-temporal`) is present with a value in `dvb-onbox env list` (checked 2026-11-08T21:15Z; value parity is not verifiable from the list).
- Credential-shaped content: 234 files (5,627,180,193 bytes) were left OUT because the PR 1751 broadened scanner found high-confidence patterns in them (base64_wrapped_credential 578, github_token_b64_field 550, jwt 8, pan_like_luhn 223, sk_token 1, upstream_api_key_field 154); by set: `cloud-bn10` 24, `cloud-bn7` 21, `cloud-bn8` 22, `cloud-tarball` 157, `cycle-final` 2, `cycles-bn-a` 3, `cycles-bn-b` 3, `deploy-state` 2. They are the fleet `shared-inventory/machines.json` files and `/var/tmp/deploy-early/bench-machines.json` (base64-wrapped GitHub token field), per-run `.upstream.json` files (upstream API key field), backend coverage `server-shard2.log` files (one JWT each), mass-agent and payment run records and driver logs (brand-structured Luhn-valid numbers), and a scratch copy of a committed RCA case document whose example number is Luhn-valid. In `cloud-tarball` the same kinds of members were skipped inside the repack; the local tarball itself stays on this devbox with them. Names, sizes and pattern names (never values) are in `unarchived-credential-bearing.json` of the `control` archive. They exist only on this devbox until the user or owner declares them unneeded or approves archiving them as opaque ciphertext. The task outcomes they describe are in the Hub and in the ledger rows below.

## 4. Benchmark history

Fresh lean worktree of `origin/main`, branch `records/pr1784-closeout`:
- `scripts/benchmark-history-backfill.py` dry run, then `--write`, against one saved Hub index: nothing to add (0 attempt rows, 0 duration rows); the counts are in `closeout-manifest.json`.
- This deploy's final smoke (`deploy-5a68051c…`, source `8edce49e3b`): the tool reports its 14 Hub rows as UNBOUND because the Hub records no `code` identity for them. The campaign's own `result.json` binds `source.head` `8edce49e3b`, an ancestor of the merge, so the rows were appended with the tool's own `hub_ledger_row()` and `write()` (`backfill_source: hub:cloud-fleet`, branch shards `*.20261108.records-pr1784-closeout.jsonl`): **14 attempt rows** (all passed) and **14 duration rows**. agent-payment-abandonment was held under no-remint custody and did not run, so it has no row. Earlier smoke campaigns of this deploy ran superseded pre-merge heads and stay out under the latest-only rule.
- `python3 scripts/benchmark-history-latest-only.py --base origin/main --check`: exit 0.

## 5. Restore without this devbox

Use a project devbox (managed env delivers `agents/.env`, `back-end/.env` and `.context/pr1634-archive-recovery.env`, key fingerprint `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`; never print them). From a checkout containing the recipe and adapter, for each archive's `receipt_sidecar_key`:

```bash
mkdir -m 700 ../pr1784-private-recovery
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key '<receipt_sidecar_key>' --output ../pr1784-private-recovery/<label>.receipt.json
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py <same options> \
  restore --receipt ../pr1784-private-recovery/<label>.receipt.json --destination ../pr1784-private-recovery/<label>
```

Members are named `pr1784-closeout-staging/...`: `worktrees/<name>/` is a worktree path, `var/tmp/` the machine path, `control/` the closeout tooling and listings. Restore the preview branch with `git fetch <restored>/control/git-preview/preview-pr1784-x-pr1770.bundle preview/pr1784-x-pr1770:preview/pr1784-x-pr1770` in a clone of origin.

## 6. Verification performed

- Every archive: full download with per-frame authentication, stream hashes and every member hash against the in-archive manifest (the recipe's own `verify`), then an encrypted receipt sidecar written and read back authenticated.
- Independent check with the unchanged PR 1634 adapter: `fetch-receipt`, then either a full restore into an empty directory (`deploy-state`, `git-preview`, `control`) or, for the large sets where a restore would not fit on disk, a streamed pass through the recipe's frame authentication; both compare every member's sha256 and size to the hash taken from the source before upload. 0 differences. `cloud-tarball` members were additionally cross-checked against the coordinator's pre-archive `sha256sum` manifest.
- Secret scan: the PR 1751 broadened scanner (key shapes, JWTs, bearer tokens, Fly tokens, Luhn-valid card numbers, base64-wrapped credentials, sensitive field names) ran on every staged file; the staging scan is bound to the uploaded bytes by the per-member sha256. Pattern based: it cannot prove the absence of every secret.
- Not verified: bucket public-access settings, env value parity with managed env, anything created after the archive cutoffs.

## 7. Deletion readiness

`deletion-check` ran from the coordinator worktree through the fixed-env wrapper (`/var/tmp/deploy-early/deploy_env.sh .context/deploy-pipeline scripts/deploy deletion-check`), with `--manifest` this directory's `manifest.json` and `--receipt` this directory's `deletion-readiness.json` (absolute paths in the records worktree; the coordinator worktree stays on `deploy/bottleneck-fixes`). Verdict: **READY** (open items: 0).

[manifest.json](manifest.json) gives every ignored path of every worktree a disposition. The coordinator worktree's paths are relative globs; every other worktree is matched by absolute path. Paths of `/home/boxes/rose`, `rose-agentcard-cloud`, `rose-blacksmith`, `rose-blacksmith-int` and `rose-deploy-measure` that have not changed since the cutoff their PR 1767 entry is bound to carry that entry and its archive binding, as do the twelve local-only branches and the stash (tips unchanged). `/home/boxes/rose/.context/deploy-scorecard-latest.json`, the one file changed there since, is archived in `deploy-state`; `/home/boxes/rose/agents/.env` and `back-end/.env` (rewritten by managed env delivery at 10:40Z) were re-checked for variable-name parity. `preview/pr1784-x-pr1770` is bound to its tip `3a74e3c136` and the `git-preview` archive. `/var/tmp/rose-claude-md` (another thread's `docs/claude-md-rewrite`) was pushed by its owner and has no ignored files; it was only inspected.

## 8. Open follow-ups

- **AgentCard production lane** (external exception above): needs the user's KYC'd live cardholder and live card.
- **Post-merge repairs** (Bugs folder, own devboxes): E benchmark-share shard Hub race https://boxes.dev/thread/thr_bcf9fc84f6404543a0d045f3b7d6f647 (resolved in the cycle); D historical-custody admission locator and typed refusal https://boxes.dev/thread/thr_5273183919324417936cb5d136895cd0; C new-user-journey Stripe Checkout ZIP https://boxes.dev/thread/thr_5a39f1d80ed34cc8ae962617f101d160; B abandonment 401/429 stall-classifier bypass, covered by https://boxes.dev/thread/thr_7654328c258b4b28b33daa76e573c178.
- **AgentCard unreleased sandbox funds** (bn8): org transfer `owt_b4f6cf8ed5eb76fd8cd294a1`, card `card_f80cea644e7618798172d9d3`, 4,396 cents, purchase `a526872b` HELD, `livemode: false`.
- **Credential-bearing files** listed in section 3, including the local smoke tarball `/var/tmp/deploy-early/archive/pr1784-deploy-cloud-20261108.tar.gz`, stay on this devbox pending the user's or owner's decision.
