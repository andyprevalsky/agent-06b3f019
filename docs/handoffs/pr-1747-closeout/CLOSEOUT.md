# PR #1747 closeout — Rose-on-Rose (root agents know their project, no sandbox outlives its owner, Rose + Codex session parity)

Deployed: PR #1747 merged as `37f705cd8dd490845af863fa808a2fb0d3b0d7c6` on 2026-11-07 20:07Z (reviewed head `02eb65acf1169fad99c707e41dfefede01acbe6b`, gated source digest `c178afcd7c2e`). This record was created after the merge, as the deploy requires, in a records-only follow-up PR.

## Outcome

- Gates (final fresh cycle, round 5): quick x4, `deploy-command-structural`, backend/frontend/agents coverage + blackbox, semantic-stack, cloudbench-controller, live-probes, e2b-smoke, seed-cache, canonical WhatsApp seed, seed-memory-ratchet all PASS; cloud smoke 13 of 14 PASS plus `agent-payment-abandonment` natively SKIPPED on the standing AgentCard release stall (recorded as a qualified resource skip, never PASS). Receipts: `evidence/final-cycle-02eb65acf1.json.gz`, `evidence/final-plan-02eb65acf1.json.gz`, `evidence/triage/`.
- Production lanes (`evidence/production-lanes-37f705cd8d.json`): render PASS (live on the merge commit), backend-probes PASS, AgentCard production lifecycle SKIPPED-elected (live-mode Stripe fixture needs a KYC cardholder only the user can provide; standing user decision of 2026-11-06), **fly BLOCKED, workflow-migration and semantic therefore NOT RUN**.
- **Why Fly did not run (open, needs the owner):** `Deploy Agents to Fly.io` is in state `disabled_manually` (updated 2026-11-07T18:32:58Z, before this merge and not by this deploy; `evidence/github-deploy-agents-workflow-state.json`). No push run exists for `37f705cd8d`, nor for the later agents commits `9ec17dde5d` and `20f6e41f20`. `.claude/commands/deploy.md` and the deprecated deploy doc require automatic worker deployment to stay off for the first managed deployment, and `docs/existing-worker-process-deployment.md` says to keep the Machine-rollout hold in effect and not to re-enable a competing deployment. I therefore did not re-enable or dispatch it. The production worker queue FIFO head was null at 20:35Z, so nothing is queued. Effect: the Fly agent runtime still runs the pre-merge bank; this PR's agent changes (`## Project` section, config-read recovery, browser download fallback provider) reach it with the next worker deployment. The production semantic gate refuses to run until the Fly gate opens (`PIPELINE_SEMANTIC status=refused`).
- Not claimed: production semantics, workflow-migration and the Fly cutover of this merge are UNVERIFIED. Run `scripts/deploy production --sha 37f705cd8dd490845af863fa808a2fb0d3b0d7c6 --lanes fly,workflow-migration,semantic` (or the managed deployment's equivalent) once the hold is lifted.

## Decision (user, 2026-11-07, after the scorecard)

The owner kept the hold: `Deploy Agents to Fly.io` stays `disabled_manually`, and this deploy is closed as merged with the Fly cutover, workflow-migration and production semantic lanes **deferred and UNVERIFIED**, to be covered by the managed worker deployment. Nothing was re-enabled or dispatched. The `blocked` outcome recorded by `scripts/deploy finish` stands; it is not relabelled `completed`.

## Deploy history (what had to be fixed or worked around)

See the PR body. In short: 13 local staged sweeps; `origin/main` absorbed the deploy-v2 rewrite while they ran (merged `b365bf8bd6`, 5 conflicts); v2 rounds 1-5. Defects found and fixed in this PR: sibling suites' non-dumpable fixture children vs the fail-closed `/proc` scan (exclusive group in `scripts/run-deploy-structural-gates.py`), a stale 56-Machine default in `reserve_worker_machine_slot`, seven CodeRabbit findings, and two bugs in this PR's own new code caught by local runs (a lost-update in the reconciler worker pool; a teardown test that depended on `ROSE_USE_SYSTEM_PG`). Environment/contention failures (stale Prisma client after the merge; the shared ngrok domain `rose-rose.ngrok.app` held by another deploy; a 0.9% coarse-mtime race in `peer_refreshed`; this devbox's own disk floor) are described in the RCA cases and in memory, with the first-bad boundary for each.

## Followups

1. Lift or consume the Fly hold, then run the three blocked production lanes (above).
2. `scripts/run-bench-cloud` `peer_refreshed_snapshot`: allow one second of slack (`[ "$written" -ge $((since - 1)) ]`) plus a deterministic test (`os.utime` at `since-1` passes, `since-2` refuses). Cause measured: 345 of 40,000 write/stat pairs on this kernel.
3. Blacksmith `semantic-stack`: concurrent deploys share one reserved ngrok domain because every runner checks out into `rose`, and the Cloudflare quick-tunnel fallback never routed from the VM. Needs a per-run domain or a fallback that routes.
4. AgentCard sandbox release stall: each smoke round leaves 4396 cents unreleased (`card_7a757a34ad7dd46cf25fdd6c`/`owt_1b4ecee28d4d3df4ba780237`, `card_68334d317ea54f64bb9050f4`/`owt_8af9c05aadaa715929cf44e7`, `card_da4366ce4e3d0914567ebd29`/`owt_62458b788e9eb302ddaaa050`; earlier local-sweep stalls `card_a1ea88a2d528abf982deae59`/`owt_9af94c9eccf0c39674679725`, agents `9a3648dd-532c-4d6f-89a3-c559b963b36b`, `347ae010-8e7a-40ea-9190-7296aba2324a`, `6d6a0d2e-23e0-4f60-9208-f972d3025cd7`). Test mode, nothing reclaimed by this deploy.
5. Fly: two idle guests of an aborted local-era smoke (`8140eeb9643168`, `8654630fd53928`) were stopped and their volumes retained; the stopped round-4 campaign left no Machines (checked by owner token).
6. Lane C (session-start optimizations) and the Template check on a fresh devbox remain follow-up deploys.

## Preservation

Four private archives (AES-GCM frames, trace R2 bucket, key id `trace-archive-prod-2026-07-03`) were uploaded and read back frame by frame. Credential-bearing names (`machines.json`, `*.upstream.json`, `.env*`) were dropped from them. Receipts are in `evidence/archive-receipt-*.json`.

| Archive | Key (under `devbox-closeout-private/pr1747-02eb65acf1/`) | Files | Original | Stored  | Ciphertext sha256                                                  |
| ------- | -------------------------------------------------------- | ----- | -------- | ------- | ------------------------------------------------------------------ |
| core    | `20261107T202353Z-core.tar.gz.aesgcm`                    | 32641 | 1640 MB  | 435 MB  | `0ee53ae2a716bf1ef2aeb2fdffb688ce0cfd2fd3d2091a76e7c03504bfeca1b3` |
| cloud   | `20261107T202353Z-cloud.tar.gz.aesgcm`                   | 5558  | 5533 MB  | 1397 MB | `a9019116dc3b295822a1e4cc081095183457c614e19ad7befaa4d99d52048a15` |
| final   | `20261107T202353Z-final.tar.gz.aesgcm`                   | 8998  | 193 MB   | 61 MB   | `afaf08c7b03ba2007bb51adb820dedae2b01c9b3c0ee30ff112f28b453d3e2da` |
| devlogs | `20261107T202353Z-devlogs.tar.gz.aesgcm`                 | 2745  | 219 MB   | 30 MB   | `f326241406ee0f6dfae96ecaa3bb3f3204b040e1226d3e7051c411c7ca22c6af` |

- `core`: superseded cycles v1-v17, review/approval state, `/var/tmp` working evidence (scripts, triage reports, samplers, the unpushed-ref bundle).
- `cloud`: the four smoke campaigns of rounds 2-5 (`c597d9ea` ceiling denial, `60393ae1` round 3, `3187c725` disk-floor INFRA STOP, `fd071e30` final).
- `final`: the final cycle state, deploy-run logs, production lane and semantic-refusal logs.
- `devlogs`: local stack logs and LLM dumps of this devbox.
- Restore as in `docs/handoffs/pr-1757-closeout/RECOVERY.md`: `private_archive.py verify|restore --receipt evidence/archive-receipt-<name>.json --destination <empty dir>`; members are named relative to `/home/boxes`.
- Pre-existing local-only work found by the deletion check, preserved in `core` as `pr1747-closeout-staging/var-tmp-integ/closeout/pr1747-unpushed.bundle`: branch `backup/cerebras-chat-quota-prepush-20261002` (14 commits, tip `12d996f0d8e2`) and stash `0e2ffe95ba40`. Neither belongs to this deploy; nothing was deleted.

## Cleanup performed

- 12 obsolete local worker checkouts (`/home/boxes/dw`, 48 GB) removed after their one dirty tracked change was saved (`/var/tmp/integ/ledger-rows/ac-final-tracked.patch`, in `core`); five leaked test-fixture shells that held them were stopped by exact PID.
- 16 leftover `agent_link_server.py` Hub instances and one `flyctl agent` from this deploy's smoke campaigns were stopped by exact PID. The side worktree `/var/tmp/integ/fixwt` was removed.
- Benchmark ledger: the 14 smoke rows of the final campaign (13 passes with durations, 1 abandonment stall) were appended from the Hub index; the campaign pinned `--ref 02eb65acf1`, whose tree is the merged tree, but the Hub rows carry no source identity, so `benchmark-history-backfill.py` classifies them UNBOUND and they were built with its own `hub_ledger_row`.
- Deletion readiness: see `deletion-readiness.json`. It stays NOT_READY only for this session's own tool-shell processes and the devbox daemon's default Codex app-server (`pid` outside the harness allow-list), as in the PR #1751 closeout; no deletion was performed or is implied.
