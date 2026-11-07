# PR1750 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists three private archives (core, workers, cloud) with their
R2 object keys, hashes and sizes; each was read back and independently verified (every file authenticated), and
the core archive was restored and compared (632/632 identical). Deployed `6e67bded0`; gated `6a85668c1`.

Restore exactly as in [../pr-1739-closeout/RECOVERY.md](../pr-1739-closeout/RECOVERY.md) with
`docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt.json>`; build the
receipt from the manifest's archive fields. Files from `/var/tmp` appear under
`pr1750-closeout-staging/var/tmp/...`. Never restore over a live checkout or database.

[scorecard.html](scorecard.html) is the final deploy card (sha256 in the manifest).
