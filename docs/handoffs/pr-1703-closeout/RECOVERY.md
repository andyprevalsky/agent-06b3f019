# PR1703 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists the four private archives (core, workers, cloud,
control) with their immutable R2 object keys and each archive's encrypted `receipt_sidecar_key`.
Deployed source: `fa676edc7e68cdf13616f945f8362c06f6cbf417`; reviewed head
`b02d32ef957b124614ca7a7b62fb5bc58f48c6e9`. Never restore over a live checkout, database or browser profile.

1. Use a project workspace with its managed R2 configuration (`agents/.env`, `back-end/.env`). The archive key is
   escrowed in the project-managed ignored file `.context/pr1634-archive-recovery.env`, variable
   `PR1634_ARCHIVE_RECOVERY_KEY_B64`; its decoded SHA256 must be
   `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`. Never print the value.
2. Use the reviewed adapter `docs/handoffs/pr-1691-closeout/recover_closeout.py` with the framed-archive helper
   `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (Python 3.11 with boto3, cryptography,
   python-dotenv; `agents/venv` has them).

```bash
mkdir -m 700 ../pr1703-private-recovery
python3 docs/handoffs/pr-1691-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key '<receipt_sidecar_key from the manifest>' --output ../pr1703-private-recovery/core-receipt.json
python3 docs/handoffs/pr-1691-closeout/recover_closeout.py <same options> \
  restore --receipt ../pr1703-private-recovery/core-receipt.json --destination ../pr1703-private-recovery/core
```

Use an empty destination per archive; `verify --receipt <file>` authenticates every frame without restoring.
Members are named relative to `/home/boxes`. Files outside `/home/boxes` (for example `/var/tmp/webdecoy-rca`
and `/var/tmp/deploy-workers`) appear under `pr1703-closeout-staging/var/tmp/...`.

## Archives

- `core`: deploy pipeline state (current and all moved-aside cycles), approval batch, review ledger, factory
  events, RCA evidence, browser recordings, local benchmark runs, `.llm-dumps`, and the whole working directory
  `/var/tmp/webdecoy-rca` (replay harness, review packets, triage inputs, logs, deploy kit).
- `cloud`: all ten cloud smoke campaign directories under `.context/deploy-cloud` (deduplicated by content).
- `workers`: gate evidence under each `/var/tmp/deploy-workers/*/.context`.
- `control`: `inventory.jsonl` (one record per path: `archived`, `duplicate` with `duplicate_of`, or `symlink`
  with target), the capture file lists, the capture and upload tools, per-archive receipts and the production
  receipts written after the core capture.

Database dumps: none were taken; local test databases were seeded from the canonical fixture and hold no unique
data.
