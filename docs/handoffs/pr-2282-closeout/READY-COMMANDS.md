# Verify and restore the preserved snapshot

The final capture, encryption upload, upload self-verification and separate full
authenticated readback are complete. The archive contains 50,143 captured regular
files plus its exact source manifest. Three symlink mappings are recorded; their
targets are preserved without dereferencing the links. The receipt records 50,144
archive files, 2,703,612,071 original bytes and 762,841,035 encrypted bytes.

From a complete Rose checkout with its existing managed archive credentials:

```bash
source agents/venv/bin/activate
python -I docs/handoffs/whm-b07d9037-preservation/private_archive.py verify \
  --receipt docs/handoffs/pr-2282-closeout/final-private-archive-receipt.json
python -I docs/handoffs/whm-b07d9037-preservation/private_archive.py restore \
  --receipt docs/handoffs/pr-2282-closeout/final-private-archive-receipt.json \
  --destination /absolute/path/to/new-empty-directory
```

Use a new empty destination. SOURCE_MANIFEST.json inside the archive, also
published as source-manifest.json here, maps staged members to their original
absolute source paths and hashes. The uploader preserves paths relative to `/home/boxes`, so the restored tree
starts at `<destination>/rose/.context/b82-closeout-prep/final-staging/`.
Captured files are beneath that directory’s `absolute/` tree (for example,
`absolute/home/boxes/rose/.context/` and `absolute/tmp/b82-preservation/`), and
`SOURCE_MANIFEST.json` is beside that `absolute/` directory. The archive-level
`MIGRATION_MANIFEST.json` is at `<destination>/MIGRATION_MANIFEST.json`. Restore into the empty directory first;
review those mappings before copying individual files. Recreate the three
recorded symlinks only after their targets are restored, using the exact relative
`target` values in symlink-targets.json; refuse to overwrite an existing path. Do not overwrite a live
checkout, managed environment files, or protected instructions. Managed secrets
were excluded and must be provided through their existing managed channels.
The object locator and encryption key identifier in the receipt are restoration
metadata; no plaintext key or access token is published.

The original preparation script is preserved for audit. Do not rerun staging or
upload commands to replace this verified immutable capture. Historical branch
and stash receipts are referenced by exact tip in closeout-manifest.json. Their
complete remote readbacks and bundle checks are recorded in the archive.

The canonical deletion check is separate from archive verification:

```bash
DEPLOY_TEST_CYCLE_STATE_DIR=.context/deploy-pipeline-final scripts/deploy deletion-check \
  --manifest docs/handoffs/pr-2282-closeout/closeout-manifest.json \
  --receipt docs/handoffs/pr-2282-closeout/deletion-readiness.json
```

The receipt must be committed in the reviewed records-only follow-up, merged,
linked from PR #2282, and the check rerun on the clean published branch. READY
certifies preservation and absence of owned live work; it does not authorize
actual devbox destruction. Post-capture status and final scorecard metadata are
derived from durable receipts and separately published. No private trajectory
was generated after the capture.
