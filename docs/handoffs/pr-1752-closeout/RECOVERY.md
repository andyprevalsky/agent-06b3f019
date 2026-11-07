# PR1752 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists five private archives (core, workers, cloud, control and the
failing mass-agent run handed to its repair) with their R2 object keys, hashes and sizes. Each was read back and
independently verified (every file authenticated); the core archive was restored and compared. Deployed
`818f3669f`; gated `db7cce8d2`.

Restore exactly as in [../pr-1739-closeout/RECOVERY.md](../pr-1739-closeout/RECOVERY.md) with
`docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt.json>`; build the
receipt from the manifest's archive fields. Files from `/var/tmp` appear under
`pr1752-closeout-staging/var/tmp/...`. Never restore over a live checkout or database.

- `core`: every staged-cycle state directory (final cycle 9 plus the eight superseded/aborted cycles), review
  ledger and dispositions, approval batch, deploy-runs, and `/var/tmp/rca-8765` (repro harnesses, churn load,
  logs, triage/focus/handoff inputs, archive listings).
- `workers`: the ten `/var/tmp/rose-workers/*/.context` worker evidence roots.
- `cloud`: every cloud smoke campaign under `.context/deploy-cloud` (seven campaigns).
- `control`: copies of the root-owned systemd service logs, capture listings and archive receipts.
