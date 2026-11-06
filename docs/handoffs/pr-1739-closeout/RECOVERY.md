# PR1739 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists the four private archives (core, workers, cloud, control)
with their immutable R2 object keys, hashes and sizes; [private-preservation-verification.json](private-preservation-verification.json)
records the independent authentication of every frame and a restore comparison. Deployed source:
`58e2f7ef54fe0d4cf61987b353e2aeae9015e8b2`; validated head `f3026d2e6d740d77b06a60b7656a9933b40474b3`.
Never restore over a live checkout, database or browser profile.

1. Use a project workspace with its managed R2 configuration (`agents/.env`, `back-end/.env`). The archive key is
   escrowed in the project-managed ignored file `.context/pr1634-archive-recovery.env`, variable
   `PR1634_ARCHIVE_RECOVERY_KEY_B64`, and in `agents/.env` `TRACE_ARCHIVE_ENCRYPTION_KEY_B64`; the decoded SHA256 of
   both is `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`. Never print the value.
2. Use `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (Python 3.11 with boto3, cryptography,
   python-dotenv; `agents/venv` has them). It takes a receipt JSON; the receipt fields are in the manifest
   (`key`, `ciphertext_sha256`, `manifest_sha256`, `frames`, `files`, `stored_bytes`, `original_bytes`,
   `gzip_sha256`, `encryption_key_id`, `bucket`, `format`) and its schema is the uploader's own receipt
   (`format: ROSE-PRIVATE-TAR-GCM-V1`).

```bash
mkdir -m 700 ../pr1739-private-recovery
python3 docs/handoffs/whm-b07d9037-preservation/private_archive.py verify --receipt <receipt.json>
python3 docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt <receipt.json> \
  --destination ../pr1739-private-recovery/core
```

Use an empty destination per archive. Members are named relative to `/home/boxes`; files that lived under
`/var/tmp/rdw/<gate>/.context` appear under `pr1739-closeout-staging/var/tmp/rdw/<gate>/.context` (workers archive).

## Archives

- `core`: deploy pipeline state, review ledger, approval/cycle receipts, factory events, local test runs and the
  repair evidence under `evidence/cutover` (original workflow histories and start inputs of the two wedged
  agents, agent exports before archiving, validation cycles including the superseded one and the failed first
  attempt, production logs, scratch scripts).
- `workers`: the gate evidence under each of the ten `/var/tmp/rdw/*/.context` worker roots.
- `cloud`: the cloud smoke campaign directories under `.context/deploy-cloud`.
- `control`: the capture file lists, `list-skipped.json` (symlinks with targets, non-regular files) and the
  uploader receipts.

Worker checkouts, node_modules, venvs and databases are reproducible from the pushed commit and the documented
setup and are not archived.
