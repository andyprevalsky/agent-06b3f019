# PR 1751 deletion-readiness closeout

Status: final record written after the merge; the committed `deletion-readiness.json` receipt beside it is the record of record for deletion readiness.

- Deployed PR: #1751, branch `deploy-v2-rewrite`, merged SHA: `87b887bd39f8d762976fb33511aaafcb8e023512`; records PR: RECORDS_PR_LINK.
- Source HEAD when the archives were taken: `27f76e593bb59838e0d2768d00dd6e87820c82a8`; the object prefix `devbox-closeout-private/pr1751-9997bca3/` uses that HEAD, not the merged SHA.
- Inventory time: 2026-11-07T16:22:25Z (point in time; the deploy was still running when most archives were taken).
- No credential, key, signed URL or secret value is in this record. Env files appear by name and variable count only.

## 1. What is preserved, and where

Private archives are AES-256-GCM framed gzip tars in the existing private R2 bucket `trace-archive`, uploaded as new objects only. Each has an encrypted receipt sidecar (`<key>.receipt.aesgcm`).

| Archive | Object key (under `devbox-closeout-private/pr1751-9997bca3/`) | Files | Original | Stored | Ciphertext sha256 | Status |
|---|---|---:|---:|---:|---|---|
| core | `20261107T062403Z-core-5578eff54006.tar.gz.aesgcm` | 4,096 | 104.7 MB | 41.4 MB | `d5b3e78cc5dfaee7e6523797fc74da101fb23aff1978e932b4f78e0e1a46b448` | current |
| git | `20261107T062453Z-git-91703446f000.tar.gz.aesgcm` | 24 | 69.9 MB | 2.5 MB | `abb95670c8478b7ffb04e9094e15a53697795700b8dd49cf1837929556e9531f` | current |
| worktrees2 | `20261107T063134Z-worktrees2-895ad1d69921.tar.gz.aesgcm` | 1,332 | 9.0 MB | 2.0 MB | `543af59cc059e1897cdfd27d4a1b3d697ae95ee6b47cd7ee1bfc5ac7de7c9b2a` | current |
| agentcard-proof2 | `20261107T064554Z-agentcard-proof2-fa57a081caaa.tar.gz.aesgcm` | 723 | 448.4 MB | 83.1 MB | `bd718172bd5e87bc096b59795cf00af3255760c5dce419ed7eb456361940dfe4` | current |
| blacksmith-summaries | `20261107T063137Z-blacksmith-summaries-e64756b0b9bb.tar.gz.aesgcm` | 26 | 0.3 MB | 0.1 MB | `90dacfbc68358cbd63825c44d5a634e21a83e430b2889c695b257322075ba286` | current |
| control | `20261107T065006Z-control-15ee2698c703.tar.gz.aesgcm` | 67 | 9.7 MB | 1.4 MB | `0fa31b0201bf09282c151c43cac940adc134c6493e9e98f81368d2daab675208` | current |
| core-delta | `20261107T160415Z-core-delta-74280d0a58d8.tar.gz.aesgcm` | 9,668 | 562.8 MB | 112.3 MB | `20e0f1b371546a726d7c527c56e22f9cf654e4037bb71cb1a33bd38299088366` | current |
| git-delta | `20261107T161255Z-git-delta-6285442e414f.tar.gz.aesgcm` | 26 | 0.4 MB | 0.1 MB | `8435a79e3cc200d7baa0cc904eb1dd5b3ad6e24b0a0991549d350ea7bbc34cc0` | current |
| worktrees-delta | `20261107T161731Z-worktrees-delta-c8b7d6fc1dac.tar.gz.aesgcm` | 5,324 | 353.6 MB | 120.3 MB | `6da08f28a7118c6639e0c0a9ae960cbe712d5bef6e7aa6a3b791a5438ff3cbce` | current |
| cycles-a | `20261107T161443Z-cycles-a-90160e04258a.tar.gz.aesgcm` | 20,401 | 678.3 MB | 157.0 MB | `4c4070cbf003f426b57ca3f73f27eb48cd494bff40c2458bff48aed9ee16db20` | current |
| cycles-b | `20261107T161348Z-cycles-b-eb02a4097c96.tar.gz.aesgcm` | 13,180 | 259.4 MB | 92.3 MB | `172c0c872b568c16e2aef59fa22b2923b9c3dca52109e974adbe7c7eddbbbf6d` | current |
| cycles-c | `20261107T161411Z-cycles-c-85fa6bc82480.tar.gz.aesgcm` | 19,985 | 389.4 MB | 138.8 MB | `d2635a8010997df1abda47a5f3163af7a75d68bbfea0fde0dca268a7069f9465` | current |
| cloud-final | `20261107T161952Z-cloud-final-1bb7393e544e.tar.gz.aesgcm` | 2,292 | 1,382.5 MB | 328.9 MB | `517db3b5783e51d2721930c3ed209e833d9c18f7eff99c7344afb30ce9b67424` | current |
| control-final | `20261107T162347Z-control-final-c40e0bcc7740.tar.gz.aesgcm` | 184 | 115.5 MB | 14.7 MB | `15f07c218b99a5ca9365c9f0d5564bbb949bc0d65c963c5cfb0abbfd743f464c` | current |
| worktrees | `20261107T062250Z-worktrees-6cd365ef48c8.tar.gz.aesgcm` | 2,695 | 34.2 MB | 18.2 MB | `f31ae3f6de733552c43de76b4773703e2c782ffe249924b28a98316f57e79ce7` | SUPERSEDED |
| agentcard-proof | `20261107T062429Z-agentcard-proof-b182a439718c.tar.gz.aesgcm` | 730 | 458.8 MB | 90.0 MB | `34157b587871027cb8458cc85879dcb0fb3d0741d9f1ca13e0f7127c25375f37` | SUPERSEDED |

Per-archive manifest hashes (sha256 of the in-archive `MIGRATION_MANIFEST.json`), sidecar hashes and frame counts are in [closeout-manifest.json](closeout-manifest.json).

Contents:
- `core`: the deploy checkout evidence the repo does not track: `.context` (deploy-pipeline state, review ledger, approval batch, factory events, deploy runs, worker ledgers, test runs, trace-archive outbox), `.llm-dumps`, local service logs, the gitignored root `package-lock.json`; plus the `/var/tmp` and `/tmp` deploy records (measurement evidence, swap/verify logs and scripts, patches, PR body/approval packet, thread-discovery record, probe and RCA scratch with results). **Point in time**: taken while the deploy was running.
- `git`: a thin `git bundle` (535 KB) carrying the four local-only branches and the stash commit, per-branch textual diffs and mbox files, the stash as patches, the complete list of local branch heads (617) and the worktree list.
- `worktrees2`: small evidence directories of the sibling worktrees (`.context`, `.llm-dumps`) including the four worktrees retired during the deploy.
- `agentcard-proof2`: `rose-agentcard-cloud/.context` (AgentCard proof campaigns and runs) minus seven credential-bearing files (a Fly `machines.json` inventory and six `.upstream.json`); their names, sizes and hashes are in `dropped.json` of the control archive.
- `core-delta`, `worktrees-delta`: files created or changed after the first snapshots (final deploy state: factory events, review ledger and dispositions, merge record, benchmark run records, `/var/tmp` RCA/triage/approval/golden-review evidence, the RCA worktrees' `.context`/`.llm-dumps`).
- `cycles-a`, `cycles-b`, `cycles-c`: the staged gate-cycle state directories (`deploy-pipeline-round1`; `-3288396770` and `-final4`; `-final`, `-final2`, `-final3`). `deploy-pipeline` is a symlink to `-final4` (recorded in `skipped.json`).
- `cloud-final`: `.context/deploy-cloud`, the smoke campaign directories of the final cycle.
- `git-delta`: a second thin bundle (27 KB) with the eight `rca/*` branches that were never pushed, with per-branch diffs and mbox files.
- `control`: inventories, manifests, file listings with per-member sha256, scan summaries, receipts, rehearsal outputs, the tools and the patches; `unarchived-credential-bearing.json` lists what was left out and why.
- `blacksmith-summaries`: the 26 summary files the Blacksmith/Fly-fleet owner chose to keep (see section 2).

### Local-only git objects

| Ref | Tip | Commits on no remote | Archive member |
|---|---|---:|---|
| `backup/cancel-fix-wip-20261106` | `d47774795572b94fb5fd7de138aba90d7d34bfb5` | 1 | `20261107T062453Z-git-91703446f…`: `pr1751-unpushed.bundle` (sha256 `65842353766e561a6f276e5371f076b94fe6d6ea82821f83e27ea157ee3857de`) |
| `backup/cerebras-chat-quota-prepush-20261002` | `12d996f0d8e24b93c0e276d5b3f91887a0da9aca` | 14 | `20261107T062453Z-git-91703446f…`: `pr1751-unpushed.bundle` (sha256 `65842353766e561a6f276e5371f076b94fe6d6ea82821f83e27ea157ee3857de`) |
| `feat/agentcard-cloud-gate` | `eee87a81a6560e44c2bc4409a96a463776ca6595` | 3 | `20261107T062453Z-git-91703446f…`: `pr1751-unpushed.bundle` (sha256 `65842353766e561a6f276e5371f076b94fe6d6ea82821f83e27ea157ee3857de`) |
| `measure/deploy-v2-gates` | `a5256cb42252f58e90668e15b4d49cd55bbce376` | 2 | `20261107T062453Z-git-91703446f…`: `pr1751-unpushed.bundle` (sha256 `65842353766e561a6f276e5371f076b94fe6d6ea82821f83e27ea157ee3857de`) |
| `rca/agents-code-session-fixture` | `10fa4d45390cf1fc23aed141edec8cf4017ba16b` | 2 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| `rca/archive-manifest-lock-observer` | `426ad14377c46219a40723eedd4ecbfa236fc9d3` | 3 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| `rca/cloudbench-controller-hang` | `69ab326136c5a25dfb1b521d6d29060c228ca992` | 1 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| `rca/interrupted-custody-proc-eacces` | `1df6407f7b4dc0b0366687da12d85b1827e27207` | 3 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| `rca/local-cleanup-quiet-eacces` | `b8afdc0d9b63d8bbab78cf7f803b2f631d1bbf3a` | 2 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| `rca/mass-agent-attempt-completion-error` | `2c57c70131c508b367589f6b465fafc6816a7594` | 1 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| `rca/payment-abandonment-no-card-request` | `839281e798d6383875ad84e2155e093bba6fe21c` | 1 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| `rca/sharded-routing-fixture-git-cleanup` | `65969566529555e2d0cd6db1bfe799386ba26639` | 1 | `20261107T161255Z-git-delta-628…`: `pr1751-unpushed-git-final.bundle` (sha256 `c7497d2ec34617808a5238f5dc3e26dad402d7e29145c289a9121c794cb64898`) |
| stash `0e2ffe95ba40…` (`On andyprevalsky/rose-run-copy: pre-sync deploy retry and explore recovery work`) | `0e2ffe95ba40a2d0c2b8ae9e884b4a85d96af3f2` | 3 commits (stash, index, untracked) | same bundle plus `stash.0.*` patches |

The bundle is thin: its prerequisites are 10 commits that are all reachable from `origin/main` or `origin/deploy-v2-rewrite` on GitHub (`bundle-prerequisites-on-remote.txt` in the `git` archive). A standalone `git clone <bundle>` is therefore impossible; restore into a clone of the repository. The stash belongs to another session (`andyprevalsky/rose-run-copy`, 2026-10-01, 10 files, +7,262/-10) and is preserved verbatim, not judged.

### Worktrees at the final inventory

| Worktree | Branch | HEAD | Uncommitted | Unpushed | Owner |
|---|---|---|---:|---:|---|
| `/home/boxes/rose` | `deploy-v2-rewrite` | `27f76e593bb5` | 1 | 0 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-agentcard-cloud` | `feat/agentcard-cloud-gate` | `eee87a81a656` | 0 | 3 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-base-measure` | `feat/judge-azure-fallback` | `08ce2ac630f6` | 0 | 0 | Blacksmith/Fly-fleet thread ph7evm73qcb922emmb8de5rgb98hp5rr |
| `/var/tmp/rose-blacksmith` | `feat/blacksmith-deploy-gates` | `b619e4f7dfa3` | 0 | 0 | Blacksmith/Fly-fleet thread ph7evm73qcb922emmb8de5rgb98hp5rr |
| `/var/tmp/rose-blacksmith-int` | `feat/blacksmith-gate-integration` | `c47c507e9677` | 0 | 0 | Blacksmith/Fly-fleet thread ph7evm73qcb922emmb8de5rgb98hp5rr |
| `/var/tmp/rose-deploy-measure` | `measure/deploy-v2-gates` | `a5256cb42252` | 0 | 2 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-rca-abandon` | `rca/payment-abandonment-no-card-request` | `839281e798d6` | 10962 | 1 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-rca-agents` | `rca/agents-code-session-fixture` | `10fa4d45390c` | 0 | 2 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-rca-archive` | `rca/archive-manifest-lock-observer` | `426ad14377c4` | 0 | 3 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-rca-custody` | `rca/interrupted-custody-proc-eacces` | `1df6407f7b4d` | 0 | 3 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-rca-massagent` | `rca/mass-agent-attempt-completion-error` | `2c57c70131c5` | 0 | 1 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |
| `/var/tmp/rose-stabilize` | `fix/pr1751-stabilization` | `2d1df69c3a57` | 0 | 0 | deploy coordinator (ph79ggq9e3zssc2h7wmkwfr9cx8hn4ey) |

The same table with full HEADs is `worktree-heads.json` in the `control` archive.

## 2. Not archived, and why

Reproducible (regenerate, do not restore):
- `node_modules/` (root, `front-end`, `back-end`): `npm ci` at the root, `npm ci --workspaces=false` in the package directory.
- `agents/venv/`: `python3.11 -m venv venv && pip install -r requirements.txt` in `agents/`, or `bash scripts/cloud-build.sh`.
- Reference repos `codex/ hermes-agent/ openclaw/ prime-agent/ kimi-code/`: `bash scripts/sync-reference-repos.sh`.
- `__pycache__`, `.pytest_cache`, `front-end/playwright-report/`, `.context/tsbuildinfo/`, `.context/frontend-builds/`: regenerated by the owning tools.
- `/var/tmp/fetchtest` (clones of origin at `736911710`), per-test scratch under `/var/tmp` and `/tmp`: recreated by the tests.

Configuration and secrets (names only, never archived):
- `agents/.env`: managed project env; every variable name is present in `dvb-onbox env list` with a value (value parity not verifiable from the list).
- `back-end/.env`: managed project env; every variable name is present in `dvb-onbox env list` with a value (value parity not verifiable from the list).
- `front-end/.env`: managed project env; every variable name is present in `dvb-onbox env list` with a value (value parity not verifiable from the list).
- `mac-app/.env`: managed project env; every variable name is present in `dvb-onbox env list` with a value (value parity not verifiable from the list).
- `research/.env`: managed project env; every variable name is present in `dvb-onbox env list` with a value (value parity not verifiable from the list).
- `agents/.env.benchmark-temporal`: managed project env; every variable name is present in `dvb-onbox env list` with a value (value parity not verifiable from the list).
- `.env.npm`: managed project env; every variable name is present in `dvb-onbox env list` with a value (value parity not verifiable from the list).
- `.context/pr1634-archive-recovery.env`: managed project env; carries `PR1634_ARCHIVE_RECOVERY_KEY_B64` (fingerprint `e351c7cc…7730`).
- `.cloud-env`: regenerated per instance by `scripts/cloud-build.sh`. `.devbox/`: regenerated by boxes.dev. Home tool state (`~/.claude`, `~/.codex`, `~/.fly`, `~/.config`, `~/.ssh`, `~/.gitconfig`, `~/.npmrc`) is re-authenticated or delivered by the project, not archived.
- `/project` is a network disk (not devbox-local); user thread transcripts are out of scope.

Left out because they carry credential values (names, sizes and pattern names only are recorded; see `unarchived-credential-bearing.json` in the `control` archive):
- files left OUT of every archive because they carry credential-shaped values (2957 files, 1526123607 bytes) plus 4 superseded smoke-run tarballs; they exist only on this devbox until the user or the owner declares them unneeded or approves archiving them as opaque ciphertext.
- Locations: `root/.context/deploy-cloud` (26), `root/.context/deploy-pipeline-3288396770` (1), `root/.context/deploy-pipeline-final` (1), `root/.context/deploy-pipeline-final2` (1), `root/.context/deploy-pipeline-final3` (1), `root/.context/deploy-pipeline-final4` (1), `root/.context/deploy-pipeline-round1` (2), `var/tmp/rca-massagent-tmp` (2), `worktrees/rose-rca-massagent/.context` (2), `worktrees/rose-rca-massagent/.llm-dumps` (2918), `worktrees/rose-rca-massagent/agents` (2). Patterns: base64_wrapped_credential 3, github_token_b64_field 3, jwt 245, pan_like_luhn 86, private_key_block 2, sk_token 2670, upstream_api_key_field 17.

Owner-declared unneeded (Blacksmith/Fly-fleet thread `ph7evm73qcb922emmb8de5rgb98hp5rr`, 2026-11-07):
- `/var/tmp/rose-blacksmith/.context`: 4,743,442,409 bytes, 12,034 files. Reason given: owner decision 2026-11-07: runs/, campaigns/ and guest logs are not needed; the numbers are in the owner's chat and /project memory; every Machine and volume from those runs is verified released or destroyed. Only the 26 summary files are archived (`blacksmith-summaries`).
- `/var/tmp/rose-base-measure/.context`: 25,249,357 bytes. owner decision 2026-11-07; also excluded from worktrees2 because its fly-ab machines.json files carry credential values.

## 3. Restore without this devbox

Never restore over a live checkout, database or browser profile; use a new empty directory per archive.

1. Use a project devbox. Managed env delivery provides `agents/.env`, `back-end/.env` (R2 connection values) and `.context/pr1634-archive-recovery.env` (variable `PR1634_ARCHIVE_RECOVERY_KEY_B64`, decoded sha256 `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`). Never print these.
2. Check out a commit containing `docs/handoffs/pr-1634-closeout/recover_closeout.py` and `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (Python 3.11 with boto3, cryptography, python-dotenv; `agents/venv` has them). For each archive take its `receipt_sidecar_key` from `closeout-manifest.json`:

```bash
mkdir -m 700 ../pr1751-private-recovery
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key '<receipt_sidecar_key>' --output ../pr1751-private-recovery/<label>.receipt.json
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py <same options> \
  restore --receipt ../pr1751-private-recovery/<label>.receipt.json --destination ../pr1751-private-recovery/<label>
```

Members are named `pr1751-closeout-staging/...`: `root/` is the deploy checkout, `var/tmp/` and `tmp/` the machine paths, `worktrees/<name>/` a sibling worktree, `control/` the git artifacts (and, in `control`, the inventory, listings, tools and patches).

3. Source: in a clone of the repository with `origin` fetched:

```bash
git bundle verify pr1751-unpushed.bundle
git fetch pr1751-unpushed.bundle 'refs/heads/*:refs/recovered/heads/*' 'refs/stash:refs/recovered/stash'
git stash store -m "recovered pre-sync deploy retry and explore recovery work" refs/recovered/stash   # optional: re-create the stash entry
```

The restored `stash.0.tracked.diff` and `stash.0.untracked.diff` must equal `git diff --binary --full-index <stash>^1 <stash>` and the empty-tree diff of `<stash>^3`.

## 4. Verification performed

- Every archive: full download, per-frame authentication, stream hashes, every member hash against the in-archive manifest (the recipe's own `verify`).
- Independent restore: the unchanged PR 1634 adapter (`fetch-receipt` then `restore`) into an empty directory, then every member compared by sha256 and size to the hash taken from the source before upload; sidecar ciphertext hash compared. 0 differences for each current archive.
- Bundle: `git bundle verify`, then recovered into a repository containing only origin history (the 7 local-only commit objects absent before, present after); the four branch diffs and both stash diffs are byte-identical to the saved patches; connectivity (`rev-list --objects`) ok.
- Secret scan before upload: key shapes, JWTs, bearer tokens, Fly tokens, Luhn-valid card numbers, base64-wrapped credentials and sensitive field names, with positive controls; names and counts only. See known limits for the first object.
- Not verified: bucket public-access settings (control-plane), environment value parity with managed env, that GitHub still holds the bundle prerequisites at restore time, anything created after the archive cutoffs.

## 5. Deletion-readiness status

`scripts/deploy deletion-check --manifest manifest.json` reads [manifest.json](manifest.json): path globs for ignored files (absolute globs for sibling worktrees), and `branch:<name>` / `stash:<commit>` / `commit:<sha>` keys for local-only git objects. A git-object entry counts only as a dict `{"disposition": "archived", "tip": <current commit>, "archive": <R2 object key>, "sha256": <64-hex ciphertext sha256>}` whose tip equals the branch tip or stash commit.

Findings about the check itself while closing out this devbox (each has a patch and a regression in `scripts/tests/deploy-cli.test.py`):
- The stock check had no way to clear local-only branches or a stash (it only reads ignored paths). Fixed by the `branch:`/`stash:`/`commit:` entries above; a branch that moves after it was archived is reported again.
- The harness helper `pidfd-janitor <session pid>` keeps the agent's cwd in the checkout and made READY unreachable from an agent session (fixed on the stabilization branch). The exemption by executable prefix also hides other threads' agent sessions (`/opt/devbox-tools/claude`, `codex`) and any process on the shared node runtime; a narrower rule is proposed as an optional patch.
- Ignored files of sibling worktrees were never examined, although they are deleted with the devbox (here: a 4.4 GB evidence directory in one worktree). Fixed by requiring a disposition for every worktree's ignored paths (absolute-path globs in the manifest); a symlinked directory such as a shared `agents/venv` is now recognised as reproducible.
- Original commits of branches whose content was cherry-picked into another branch stay "on no remote" until they are pushed or archived; the check cannot know they are equivalent.

Open items at the inventory time are live work of the running deploy and its RCA workers (unpushed worktrees, live processes) and clear when they are pushed or finished; the final `deletion-check` receipt is the record of record.

## 6. Known limits and open follow-ups

- **worktrees-v1-credential-values**: superseded by worktrees2; contains credential values (a GitHub OAuth token, API keys, per-run owner/barrier tokens) inside an object encrypted with the escrowed key; deletion and token rotation are pending the user's decision. Object `20261107T062250Z-worktrees-6cd365ef48c8.tar.gz.aesgcm` (sidecar `20261107T062250Z-worktrees-6cd365ef48c8.tar.gz.aesgcm.receipt.aesgcm`), 2,695 files, 34,220,977 bytes original, 18,227,659 bytes stored, ciphertext sha256 `f31ae3f6de733552c43de76b4773703e2c782ffe249924b28a98316f57e79ce7`, manifest sha256 `8183864fdf8a4b29ecfe6e76ce909276dd583c31d5ba3345d98c7d25494ab237`. members under pr1751-closeout-staging/worktrees/rose-base-measure/.context/fly-ab/ (machines.json and run files); no value appears in this record.
- **agentcard-proof-v1-credential-values**: superseded by agentcard-proof2; contains credential values (a GitHub OAuth token, API keys, per-run owner/barrier tokens) inside an object encrypted with the escrowed key; deletion and token rotation are pending the user's decision. Object `20261107T062429Z-agentcard-proof-b182a439718c.tar.gz.aesgcm` (sidecar `20261107T062429Z-agentcard-proof-b182a439718c.tar.gz.aesgcm.receipt.aesgcm`), 730 files, 458,792,346 bytes original, 89,998,018 bytes stored, ciphertext sha256 `34157b587871027cb8458cc85879dcb0fb3d0741d9f1ca13e0f7127c25375f37`, manifest sha256 `8aa3ef19c92959a46d130b644aa5b6537f45e64493759e3f60637905b7837e8d`. campaigns/agentcard-proof-1/shared-inventory/machines.json and six runs/*/*/.upstream.json under pr1751-closeout-staging/worktrees/rose-agentcard-cloud/.context/agentcard-proof/; no value appears in this record.
- **credential-bearing-evidence-not-archived**: files left OUT of every archive because they carry credential-shaped values (2957 files, 1526123607 bytes) plus 4 superseded smoke-run tarballs; they exist only on this devbox until the user or the owner declares them unneeded or approves archiving them as opaque ciphertext. See unarchived-credential-bearing.json in the control archive (names, sizes, pattern names only); tarballs: /var/tmp/deploy-cloud-archive-1751/*.tar.gz with SHA256SUMS (archived).
- `core` is a point-in-time snapshot of a live deploy; the delta archives hold files created or changed afterwards. Nothing was archived after the final inventory time above.
- At the final inventory the deploy checkout was still on `deploy-v2-rewrite` with one uncommitted ledger file; the records branch switch happens after this record. The `deletion-check` receipt is the record of record.
- The inventory is point in time; rerun `tools/inventory.py` (in the `control` archive) before the final `deletion-check`.
- The tracked `.claude/commands/DEPRECATED_deploy.md` contains a literal 44-character `API_KEY="…"` string (pre-existing; copies of it are in `core` as `deploy-original.md` and the approval diff). Not rotated or changed here.
- The secret scanner is pattern based; it cannot prove the absence of every secret. The first `worktrees` object shows that.

## 7. State at close (after the final inventory)

- Deployed: PR #1751 merged as `87b887bd39f8d762976fb33511aaafcb8e023512`. Production lanes: render PASS, backend-probes PASS, semantic PASS, AgentCard production lifecycle SKIPPED-elected (its original FAIL, `payment_lifecycle.stripeHold.livemode must be true`, is kept in the lane reason and in `evidence/production-lanes.json`; the Stripe fixture is test mode and making it live is a KYC/billing action only the user can take; the lifecycle itself returned its funds: purchase VOIDED, wallet funding RECLAIMED, org transfer `owt_00c1b7e9bd761a7ba6d14d17` released 100 of 100 cents, card CLOSED).
- Worktrees retired without force after their content was archived or pushed: `rose-rca-agents`, `rose-rca-archive`, `rose-rca-custody`, `rose-stabilize`, `rose-rca-abandon` (its 10,962 lean-checkout deletions were restored first), `rose-rca-massagent` (its credential-bearing local run output was deliberately not archived; the RCA's evidence is kept in `/var/tmp/rca-massagent-scratch`). `rose-agentcard-cloud` and `rose-deploy-measure` stay for the user's decision, with their local-only commits bundled in the `git` archive.
- Processes this deploy started and left behind were stopped by exact PID: three `agent_link_server.py` instances from cancelled or finished smoke runs, a fourth from the INFRA-stopped campaign, and the `flyctl agent` started by the production AgentCard lane.
- Four superseded smoke run directories (about 8 GB) were archived in place to `/var/tmp/deploy-cloud-archive-1751` (entry counts verified, `SHA256SUMS` recorded) and removed from `.context/deploy-cloud` to keep smoke disk headroom. Those tarballs carry credential values and are not uploaded; only `SHA256SUMS` is archived.
- The cycle state directories are `.context/deploy-pipeline-round1` (first cycle, history), `-3288396770`, `-final`, `-final2`, `-final3` and `-final4`; `.context/deploy-pipeline` is a symlink to `-final4`, the cycle that carried the merge.
- Foreign blocker for deletion readiness: a `codex` app-server session of another boxes.dev thread (pid 1464599, started 2026-11-06 13:32Z) keeps its cwd in the checkout. It is not this deploy's process and was not touched.
- RCA case documents for this deploy, kept out of the deploy PR to avoid `docs/rca/INDEX.md` conflicts with main, land in the records PR.

