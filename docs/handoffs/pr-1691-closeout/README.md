# PR 1691 preservation closeout

This records the deletion-readiness closeout for
[PR 1691](https://github.com/Rose-Ai-Labs/rose/pull/1691), merged to `main` as
`05826f6dd4f260fdc3602ab3e63095d13d2ddc81`. The final reviewed head was
`493df34052b766e156182b7a264babaa683dcba9`. This is the records-only follow-up
required by `/deploy` Steps 11b and 13d, following the
[PR 1634 closeout](../pr-1634-closeout/README.md) pattern and tooling. It does
not change application runtime or repeat any gate.

## Deployment outcome (as recorded; not relabeled)

- Fly worker run 42138235262 succeeded. The cooperative cutover was verified at
  hash `7ce4b5046f5f`.
- Render is live on `05826f6dd` through redeploy `dep-dbmi8v3bc2fs73dem7qg`. The
  first deploy, `dep-dbmi2p0n74is73e37img`, ended `update_failed` after two
  instances deadlocked on the migrate lock for the `CONCURRENTLY` index. That
  failure is retained.
- Backend probes passed 15/15, and Step 13ac passed 45/45. Production semantic
  run 42143457242 passed 5/5.
- Post-deploy, cloud `claude-code-agent` was a REAL PASS (01:39–01:40Z,
  fleet run `20261106-011430-4091348`). It used all 3 restored logins
  (`074bfdd5`, `88a02cdc`, `6a703dd4`), and they stayed CONNECTED.
  A second post-deploy fleet run, `20261106-011458-4097574` (two browser-auth
  tasks), is preserved with its own receipts.
- Mac acceptance was SKIPPED because no Mac was available. A LocalDevice query
  for user `1f85ff25` returned 0 rows at 2026-11-06T01:41:42Z.
- Four failures were attributed `NOT_INTRODUCED` and handed to repair threads on
  new Bugs devboxes; see `failure-report.json` in the core archive. They are
  `pr1691-fps` (ph78vk2fm4g236tzeem10cdfe18hpvdq), `pr1691-mass`
  (ph79rp6vpdbew7af2hkyd505x58hq0sz), `pr1691-webdecoy`
  (ph748rvfxv8j1zba79brna917s8hqvc8) and `pr1691-structural`
  (ph75djbchs67vxpwnr1b2kjfrx8hqsyt). Their native results remain FAIL.
- CodeRabbit finding 4487727422 (`__proto__` flat filter) was deferred to the
  grep worker thread ph7c9y9h3m1pdx76hrcy7ax24d8hkd3c, as follow-up PR
  `fix/grep-proto-flat-filter`.
- The shared bench image `cloudbench-warm-20261105-230148-1909186` (built from
  `493df3405`) was activated. Its build and activation receipts are archived.
- The factory ledger was published to `main` as `beb1ceecfd` (28 rows). This
  records branch is based on that commit.

## Preservation

The [closeout manifest](closeout-manifest.json) is the index of record. It
lists every encrypted object, every grouped disposition and every record that
is not archived. The [proof index](private-proof-index.json) points to the
exact private members holding the full per-path inventory, the selection
lists, the per-archive capture manifests and the resource snapshots.
[RECOVERY.md](RECOVERY.md) explains how to restore them.
[deletion-readiness.json](deletion-readiness.json) is the committed receipt
that binds the deployed SHA, this records commit, the inventory, the archive
verification, key and configuration recovery, and resource disposition.

Source: every PR1691 branch, worker branch, `wip/` checkpoint and frozen deploy
SHA is an ancestor of `origin/main`. The 11 deploy worker clones are clean,
detached at `493df3405`, and hold no unique commits. The only local-only
commits on this devbox are 14 commits on
`backup/cerebras-chat-quota-prepush-20261002`, from October 2. They predate
PR1691 and the PR1634 source bundles preserved them.

Private evidence is AES-256-GCM framed ciphertext in the same `trace-archive`
destination PR1634 used, under `devbox-closeout-private/pr1691-05826f6d/`. It
uses the same managed key (fingerprint `e351c7cc…7730`), which is independently
escrowed in project-managed `.context/pr1634-archive-recovery.env`. No
credential, decryption key, signed URL or raw private transcript is in this
directory.

## Known historical loss (disclosed, not recovered)

With user approval, superseded backend-coverage `test-runs` and `deploy-backend`
directories were deleted from `/var/tmp/deploy-workers/backend-coverage/.context`
during the deploy. That deletion also removed, by accident, that worker's
`.port-locks` and `browser-provider-custody` journals as they existed at that
time. The directories present now were recreated by later runs, after the
deletion. Their earlier contents are lost and are not claimed as recovered.
The temporary swapfile and a scratch clone were also deleted with approval.
The retained failed and merged-failed coverage runs that survived are archived.

## Completion conditions

The private verification records keep their pre-publication state. Completion
requires that this PR is merged into `main`, that PR 1691 links the merged
commit and this manifest, and that no intended source or required record is
left only on this devbox. [publication.json](publication.json) records when
those conditions hold. No deletion was performed. Freedom, protected shared
Fly resources and other threads' assets were not changed.
