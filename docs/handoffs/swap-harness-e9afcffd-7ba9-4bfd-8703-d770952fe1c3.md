# swap-harness handoff: devbox e9afcffd (WHM), Codex -> Claude

## Migration facts
- Old devbox: `e9afcffd-7ba9-4bfd-8703-d770952fe1c3`. Harness: Codex (`gpt-6.1-sol`), exhausted. New harness: Claude.
- Main task thread: `ph7cc73xma14jdg6chxpnhbgth8g7c1a` / `thr_d2e1b555d6314abe8d9f74da7dd979aa`, title "WHM", native Codex session `01a132a3-ea1f-7b22-abfb-70608400d02e`, last turn `01a14ab0-e276-7503-b185-6c3a5cccb468`.
- Quota evidence (local session file, turn `01a14ab0-e276-7503-b185-6c3a5cccb468`, 2026-10-18T02:29:14Z): "You've hit your usage limit. ... try again at Oct 24th, 2026 8:40 PM." `usage_limit_exceeded`; weekly window 100% used.
- Coordinator thread: `ph798148z0ek3p1adb1qpv4kxd8ggn8n` on devbox `ddd569e3-1a91-4a85-9ebc-f90ae370e520`.
- Override: the user answered "U swap codex into Claude" for the four listed boxes, which overrides the swap-harness hard exclusion on Codex main tasks for this run only. Browser Mode P2 (`thr_1b5f92f0d86240bab3e7362db2a464ce`) is excluded and untouched.
- Task branch/PR: `codex/wmh-experiential-parallel-20261006`, PR https://github.com/Rose-Ai-Labs/rose/pull/1453 (ready, not merged). Pre-handoff HEAD `fab35cf750c9908040a27119afeda01a4364b1c4`; the checkpoint SHA is the commit that adds this file (see the resumed receipt).
- Skill revision: `fa1485b567a16d754dbd64d580d9ef4f65aab844`, path `.agents/skills/swap-harness`.

## Goal
Finish the WHM (world-model harness) work in PR #1453 and carry it through `/deploy`. The user's requirement: finish it, do not stall on approvals.

## Latest user steering and constraints (exact wording from the main thread)
- 2026-10-14: "finish your fucking wokr" ... "continue" ... 2026-10-15: "Let's /deploy"
- 2026-10-15: "was this already approved by me, is it just for the WHM? why do we have to modify it?" then "if this change was made WITHIN this branch, and didn't come from main, THNE NO, NOT APPROVED". Approval gates on files that originate in this branch remain in force.
- 2026-10-16: "? then finish your deploy, if u need approvals then show them...." (show approvals as exact diffs in chat per the project rule).
- 2026-10-17 16:05: "What approval is needed? And is it the last thing needed?"
- 2026-10-17 16:27 (latest): "U dont need allowance e for that just finush". AgentCard was recorded in the main thread as the user's explicit override.
- Standing: preserve Freedom; protected instruction copies untouched; never `git stash`, reset, force-push, merge main; do not kill other run-bench tasks; rules in `CLAUDE.md` (diff-in-chat for approvals, concise communication).
- The invocation authorizes checkpoints, draft PRs and this replacement. It does NOT authorize merge/deploy beyond what the task's own /deploy authority covers, subscription changes, paid API fallbacks, new paid benchmark/fleet runs during migration, or overriding task-specific constraints.
- Peer message relayed to the main thread from the Original600 lane: root will not wait for WHM capacity or a paid window; notify before any new WHM native/main/prod action; no further WHM gate or query from root.

## State at stop (2026-10-18 02:29Z)
- Commit `fab35cf75` ("Record verified WHM receipts and preserve benchmark histories") is the frozen, pushed candidate; runtime code, tests and contracts match the source that passed the checks. Worktree: `/home/boxes/rose-wmh-deploy-20261015` (branch `whm-main1577-composed-c11-20261016`, clean).
- Local testing, preservation and test-machine cleanup were reported complete by the main thread at 02:15Z. The test machine was stopped and its watchdog exited (02:09Z).
- The third and final CodeRabbit-style review cycle ran on 71 selected files and returned 8 issues. The main thread judged several real: swallowed cancellation, an incorrect clock fallback, a global ensure-session lock spanning HTTP create, `world_clock_activity` unresolved root falling to child. Peer C3 clock findings (thread `ph74jgnfbp29n7d40ajpk1cf4s8gf6hw`) say all 4 comments match actual fab35 source.
- Next action: verify each of the 8 findings against `fab35` source, batch the confirmed fixes in one commit. CAUTION: `CLAUDE.md` says a fourth review cycle blocks the deploy as review-unstable (`deploy_review_cycle.py`, `.context/deploy-review-cycle.json` in the deploy worktree). Do not start a fourth cycle or reset the counter without the user deciding; present the findings and fixes to the user as exact diffs and ask how to proceed if the counter forbids another cycle. Do not merge.
- Open helper lanes owned by the main task, to re-delegate if needed: C3 clock offline findings (`ph74jgnfbp29n7d40ajpk1cf4s8gf6hw`, "Diagnose PR1453 blackbox failures"), Run14 failure RCA lanes (`ph74rydmef2pz96ts3xq5ddmz58g72s1`, `ph7fzrvpxvg81gkrz93n23x6w58g6qhv`), and a pin-comparison lane (`ph779wwdep2vrdq46yxdhrr1r18g9251`, all 15 operating code pins equal retained fa; only guide drift adds auto-RCA registry/docs).
- Completed helper history (conclusions live in their threads and `docs/handoffs/*`): Run14 cluster investigation `ph77kpe0hjwfdk1djgww32xx598g76zv`, Run15 verifier RCA `ph78p401ehtfzc46ymcysjdxr98g6m8e`, Run14 /RCA preflight `ph73t9666702rhpqvnr4qfc55h8g7ffa`, Run15 adversarial review `ph71makpdxeaa099z2zp8ra8jd8g60cs`, Run15 cluster RCA `ph7cj6t62fe6ae8tw2nmtt08ss8g6fa3`.
- Earlier history: this box itself came from the 2026-10-12 swap of devbox b07d9037 (see `docs/handoffs/swap-harness-b07d9037-81f9-4c97-80d7-6f4d42b7adc1.md` and `docs/handoffs/whm-b07d9037-preservation/`).
- Tests: not re-run by this migration worker. Results live in `.context/deploy-*` directories (archived below) and the main thread's receipts in `docs/handoffs`. Treat pass/fail claims as the main thread's, not verified by the migration.

## Live resources
- No run-bench controller, Temporal worker or benchmark process is running on the old box (only the devbox daemon, the Codex tool server and two flyctl agent daemons). The main thread reported its test machine stopped. I did not independently query Fly inventory. The replacement must read-only verify that no WHM-owned Fly Machine or volume remains before any new action.

## Preservation inventory
Git:
- Task branch pushed; worktree `/home/boxes/rose-wmh-deploy-20261015` clean at `fab35cf75` (equals remote PR head).
- `/home/boxes/rose-wmh-resumed` (`codex/whm-resumed-generation1` `0930a0d31`): clean, contained in the remote PR branch.
- `/home/boxes/rose-wmh-reliability-followup` (`codex/whm-reliability-followup` `11dff3b99`): was unpushed; now pushed to origin under the same name. Also in the private bundle `whm-refs.bundle`.
- Local-only `recovered/whm-generation1/wmh-cache-i0..i3-run`: in the private bundle `whm-refs.bundle` (also as `wmh-cache-i*-run.patch` in `docs/handoffs/whm-b07d9037-preservation/`).
- NOT preserved: about 190 commits on old unrelated local branches in `/home/boxes/rose` (`andyprevalsky/*`, `worktree-agent-*`, `backup/*`; mostly April-July 2026, from the user's Mac clone) and `stash@{0}` ("pre-sync deploy retry and explore recovery work"). They are not WHM-owned and the full bundle exceeded free disk (about 1 GB, 2 GB free). The list is in the private archive as `localonly-refs.txt`. The old box must not be destroyed on the strength of this checkpoint if the user wants those branches; this is called out in the coordinator report.
Private, non-Git (encrypted in the trace R2 bucket, `ROSE-PRIVATE-TAR-GCM-V1`, restore with `docs/handoffs/whm-b07d9037-preservation/private_archive.py`): every regular file under the four `.context` trees newer than or absent from the earlier 2026-10-15 receipts (about 23 GB: `world-model-native-resume`, `wmh-resume-generation1`, `benchmarks`, `deploy-*`, `whm-migration`, trace archives and the rest), the nine Codex session JSONLs, `whm-refs.bundle`, `localonly-refs.txt`. Excluded as regenerable or non-data: `experiential-venv`, `node_modules`, `native-pytest-cache`, `frontend-builds`, the 41 GB swapfile `whm-migration/native-resume.swap`. Receipts and keys: see "Archive receipts" below.

## Setup notes
Environment names only: `agents/.env`, `back-end/.env`, `front-end/.env` (authoritative files must come from the project's managed env on the new box; verify `BACKEND_API_KEY` agrees without printing). Use a fresh workspace name, `CONDUCTOR_PORT`, `TEMPORAL_TASK_QUEUE=navi-agent-tasks-<unique>` and local DB; do not copy the old runtime identity. Devbox memory protocol is in `WMH_HANDOFF.md` (run heavy WHM work in a RAM-bounded systemd scope).

## Archive receipts
Four archives, each uploaded and fully read back (every frame authenticated, every member hash matched the manifest) by the uploader. Receipts are in `docs/handoffs/swap-harness-e9afcffd-receipts/`. Archive B omits 5 hardlink duplicates (`archive-B-omitted-hardlink-duplicates.json`), regenerable forensic git checkouts. The replacement must run `private_archive.py verify --receipt <receipt>` for each (needs the authoritative env files) before archival is allowed.

| Archive | Key (trace bucket) | Files | Bytes | Manifest sha256 | Receipt sha256 |
|---|---|---|---|---|---|
| A | `whm-preservation/e9afcffd/swap-20261018-A.tar.gz.aesgcm` | 28796 | 2470848381 | `863bb27a818a8452…` | `167678309df481a4…` |
| B | `whm-preservation/e9afcffd/swap-20261018-B.tar.gz.aesgcm` | 20833 | 2025239377 | `2c9d37a80f429bc3…` | `02a57821f2b2daaa…` |
| C | `whm-preservation/e9afcffd/swap-20261018-C.tar.gz.aesgcm` | 32305 | 7760190785 | `8fc1bb2be537922c…` | `cb5e7de04491659b…` |
| D | `whm-preservation/e9afcffd/swap-20261018-D.tar.gz.aesgcm` | 10 | 11255262977 | `f634ea33e3d31533…` | `317ad213ca2fb4b6…` |

## Replacement
Start key: `swap-harness-replacement-e9afcffd-7ba9-4bfd-8703-d770952fe1c3-20261018T0228Z`. Replacement IDs, continuation receipt and archive disposition are appended below.

## Replacement (actual)
- Start key above; accepted request `f8db6d1e-6ee3-4553-a4ab-da4f51a94fda`. Launch reported devbox `7d3c917c-03d6-49e7-acf2-01a68a836d5e`, thread `ph77g7y3qw0ht4vay0vp392ejn8gg7k3` (public `thr_fbdefb2e238e431abd1cfac3c76ad29c`, https://boxes.dev/thread/thr_fbdefb2e238e431abd1cfac3c76ad29c).
- Continuation receipt: `docs/handoffs/swap-harness-e9afcffd-7ba9-4bfd-8703-d770952fe1c3-resumed.json` (2026-10-18T04:05Z). The replacement authenticated all four archives (A 28796, B 20833, C 32305, D 10 files).

## Archive disposition: HELD (old box NOT destroyed)
1. Fly app `navi-whisper-lux-bench` still retains stopped Machine `820224f7e069e8` (`whm-deploy-g4-fb24dd03-20261015`) and volume `vol_r7ymddjdkx9y21gr`, found by the replacement's read-only check. Ownership/retirement is undecided (a peer message said it was deliberately retained). Needs an owner decision.
2. About 190 commits on old unrelated local branches and `stash@{0}` exist only on this box (not WHM-owned; bundle too large for free disk). The user should confirm they are disposable.
