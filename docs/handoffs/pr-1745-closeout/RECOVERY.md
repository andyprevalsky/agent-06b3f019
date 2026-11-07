# PR1745 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists three private archives (core, workers, cloud) with
their R2 object keys, hashes and sizes; each was read back and independently verified (every file
authenticated), and the core archive was restored and compared. Deployed `0b3fda43f`; gated `9d8a8fcbd`.

Restore exactly as in [../pr-1739-closeout/RECOVERY.md](../pr-1739-closeout/RECOVERY.md) with
`docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt.json>`; build
the receipt from the manifest's archive fields. Files from `/var/tmp` appear under
`pr1745-closeout-staging/var/tmp/...`. Never restore over a live checkout or database.

- `core`: every staged-cycle state directory (final plus the four aborted/collided cycles), review ledger,
  approval batch, factory events, RCA repro runs (`.context/test-runs`) and `/var/tmp/rca-imsg`
  (repro logs, reviewer results, inventory, wrapper scripts).
- `workers`: the eleven `/var/tmp/rdw/*/.context` worker evidence roots (raw coverage temp data excluded).
- `cloud`: every cloud smoke campaign directory under `.context/deploy-cloud` (four campaigns).
