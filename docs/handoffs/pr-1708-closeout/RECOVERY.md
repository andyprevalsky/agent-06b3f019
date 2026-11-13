# PR1708 recovery

This is the initial verified preservation record. The release is still in progress;
final gate, production, cleanup and deletion-readiness records must be preserved
in a reviewed records-only follow-up before deploy completion.

Obtain the project-managed `agents/.env`, `back-end/.env`, and
`.context/pr1634-archive-recovery.env` on a fresh workspace. The latter contains
`PR1634_ARCHIVE_RECOVERY_KEY_B64`; its decoded SHA256 must match the fingerprint
in `closeout-manifest.json`. Never print or commit the key. Its project-managed
value and the R2 credential definitions were checked present through `dvb-onbox
env list --json`. The local key matched the existing reviewed PR1634/PR1691
fingerprint.

Use the byte-identical recovery adapter copied from PR1691. With Python 3.11,
boto3, cryptography and python-dotenv installed, run:

```bash
python3 docs/handoffs/pr-1708-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key '<receipt_sidecar_key in initial-private-archive.json>' \
  --output /new-empty-recovery/receipt.json
```

Then use the same adapter/configuration arguments with
`restore --receipt /new-empty-recovery/receipt.json --destination /another-empty-directory`.
The helper authenticates every frame and checks every restored member hash.
Members contain immutable snapshots under `rose/.context/pr1708-preservation/initial-snapshot/`,
followed by each original absolute path without its leading slash. Restore only
into an empty isolated directory. Never overwrite a live checkout, database,
browser profile, machine identity or Freedom configuration.

All 129 initial members were actually restored and verified after upload. The
private inventory records their original paths and hashes. The encryption-key
ID label retained by the legacy helper is advisory; use the fingerprint above.
Source, regression tests and RCA cases are committed in PR1708; dependency and
worker source copies are reproducible. Worker runtime receipts are a required
post-run delta, not silently excluded from preservation.
