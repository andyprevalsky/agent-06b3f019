# PR1691 preservation recovery

Use [closeout-manifest.json](closeout-manifest.json) to select an archive's
immutable object key and its encrypted `receipt_sidecar_key`. The deployed
source is `05826f6dd4f260fdc3602ab3e63095d13d2ddc81`, and the reviewed head is
`493df34052b766e156182b7a264babaa683dcba9`. Recovery must not restore over a
live checkout, a running database, a browser profile or a managed machine
identity.

1. Obtain a fresh project workspace with its managed R2 configuration
   (`agents/.env`, `back-end/.env`). The archive key is independently escrowed
   in the project-managed ignored file `.context/pr1634-archive-recovery.env`,
   variable `PR1634_ARCHIVE_RECOVERY_KEY_B64`. PR1691 reuses the unchanged
   PR1634 key. Its decoded SHA256 must be
   `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`. Never
   print the value or put it in shell arguments.
2. Use the reviewed adapter in this directory, `recover_closeout.py`. It is
   byte-identical to the PR1634 adapter (SHA256
   `0c469e18e5b391bedc53669781e2633145d564156476955097be51ec554afe32`). It
   delegates all framing, authentication, member-hash verification and
   empty-directory restore to the unchanged legacy helper,
   `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (Git blob
   `592c092502cae2f08015858f98cdd1b5d436310b`, SHA256
   `2e35e736660660bb6118a939d51b0dd008abe5efaa6387cf252d5d0536b75cf4`).
3. Use Python 3.11 with `boto3`, `cryptography` and `python-dotenv`. The
   project's `agents/venv` already has them.

```bash
mkdir -m 700 ../pr1691-private-recovery
python3 docs/handoffs/pr-1691-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key '<receipt_sidecar_key from the manifest>' \
  --output ../pr1691-private-recovery/core-receipt.json
python3 docs/handoffs/pr-1691-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  restore --receipt ../pr1691-private-recovery/core-receipt.json \
  --destination ../pr1691-private-recovery/core
```

Use a separate empty destination for each archive. Members are named relative
to the filesystem root (for example `home/boxes/rose/.context/deploy-pipeline/cycle.json`
or `var/tmp/deploy-workers/backend-coverage/.context/...`). Authentication
failures, a wrong key, member-hash mismatches, a nonempty destination and
unsafe paths must stay failures. Do not bypass them.

## Archives

- `core`: the PR1691 deploy pipeline (current and every moved-aside `cycle.*`,
  `attempts.*` and `plan.*`), the deploy run and its failure report, the
  approval batch, the review ledger and dispositions, and the factory events.
  It also holds the post-deploy fleet runs, RCA evidence for `34e5cce9`, the
  cited `.llm-dumps`, `/var/tmp/rca-codeagent`, the `/tmp/pr1691-prod`
  production logs and the local configuration files. Read-only `pg_dump -Fc`
  copies of the 22 databases created or used during the PR1691 window are
  included, plus the globals and closeout snapshots (refs, processes, Fly bench
  Machines, databases).
- `cloud`: all 11 smoke campaign directories under `.context/deploy-cloud`.
- `backend`: the backend-coverage worker's retained failed and merged-failed
  runs and its gate evidence.
- `workers`: gate evidence and preparation receipts for the other 10 workers.
- `control`: the private inventory, selection lists, capture manifests and
  closeout tooling. [private-proof-index.json](private-proof-index.json) gives
  exact member/size/SHA256 pointers into it.

Restore database dumps only into new local databases, with
`pg_restore --no-owner -d <new db> <dump>` on PostgreSQL 16. Never restore them
into production. They are test databases seeded from the canonical fixture and
hold no unique production data.

## Per-path dispositions

The private `inventory.jsonl` in the `control` archive has one record per
path, or per grouped reproducible directory. Each record gives the disposition
(`archive` with its set, `reproducible` with its regeneration source,
`deduplicated` with the canonical original, `symlink-metadata` with the literal
target, `committed`, or `managed-escrow`), the size, `mtime_ns` and mode.
Recreate symlinks only inside an isolated recovery tree. Their targets are
either tracked source at `493df3405` or archived files. Worker env files are
byte-identical to the archived canonical configuration. Do not copy them over a
live environment, and do not restore old machine identities.

Source needs no archive. Clone GitHub and check out
`05826f6dd4f260fdc3602ab3e63095d13d2ddc81`; every PR1691 ref is in `main`.
Dependencies (`node_modules`, `agents/venv`, `.context/experiential-venv`),
caches and the bundled frontend build are regenerated from the committed
lockfiles, setup scripts and `scripts/run.sh`.
