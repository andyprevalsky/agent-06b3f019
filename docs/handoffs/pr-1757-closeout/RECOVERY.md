# PR1757 preservation recovery

`closeout-manifest.json` lists every private archive with its immutable R2 key, hashes and sizes. The receipts are in
`evidence/archive-receipt-*.json`. Every archive was read back and authenticated frame by frame at upload (`verify` passed).

1. Use a project workspace with its managed `agents/.env` (R2 credentials and `TRACE_ARCHIVE_ENCRYPTION_KEY_B64`, key id
   `trace-archive-prod-2026-07-03`). This is the same key escrow as `docs/handoffs/pr-1739-closeout/RECOVERY.md`. Never print the key.
2. Restore each archive into its own empty directory:

```bash
agents/venv/bin/python docs/handoffs/whm-b07d9037-preservation/private_archive.py verify \
  --receipt docs/handoffs/pr-1757-closeout/evidence/archive-receipt-<name>.json
agents/venv/bin/python docs/handoffs/whm-b07d9037-preservation/private_archive.py restore \
  --receipt docs/handoffs/pr-1757-closeout/evidence/archive-receipt-<name>.json --destination <empty dir>
```

Members are named relative to `/home/boxes`. Copies of the `/var/tmp/rca-mass` work tree sit under
`pr1757-closeout-staging/var-tmp-rca-mass-copy/`. Never restore over a live checkout, database or browser profile.

Archives:
- `rca`: the RCA work tree:
  - Temporal histories of the failing child and root workflows
  - py-spy profile
  - local repro bench logs and CPU samples
  - instrumented-arm worker logs
  - the four local benchmark runs
  - cycle state of the a6353fb attempt
- `cloud`: the fleet runs of the d18703e cloud rerun and the first deploy smoke campaign (a6353fb).
- `final`: deploy evidence produced after the first two archives:
  - final and archived cycle state
  - INFRA-stopped and final smoke campaigns
  - production receipts and logs
- `owner-recovery`: the 2026-11-08 Machine recovery:
  - recovery logs
  - exact-owner ownership and audit records
  - native Machine list
  - evidence recaptured from the guests of campaign 714d48a0

The original failing run is archived separately (owner: the PR1752 closeout). Its key is
`devbox-closeout-private/pr1752-818f3669/mass-agent-spawn-agent-error-run.tar.gz.aesgcm`.
