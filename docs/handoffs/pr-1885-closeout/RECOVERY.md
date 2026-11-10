# Private recovery

Use a fresh private checkout and new output directories. The managed project environment must supply R2 read credentials and the original `TRACE_ARCHIVE_ENCRYPTION_KEY_B64` matching `archive-index.json`. Never print or commit those values. A different key cannot recover these objects.

`recover_archive.py` verifies ciphertext hashes, AES-GCM authentication and the complete plaintext hash. It refuses to overwrite an output file or extraction directory. Extraction creates private data files, records links as metadata and never restores old identities or starts processes.

For example, from a configured checkout:

```bash
agents/venv/bin/python docs/handoffs/pr-1885-closeout/recover_archive.py \
  --archive original-native \
  --output /tmp/rose-pr1885-recovery/original.tar.gz \
  --extract /tmp/rose-pr1885-recovery/original
```

Repeat for the archive IDs in `archive-index.json`, each with distinct new paths. Omit `--extract` for `inherited-git-refs`; that plaintext is a Git bundle. Inspect it with `git bundle list-heads` and import deliberately into a new repository, rather than replacing a live repository's refs or config. It retains all 19,533 original refs, including the inherited stash. Current repair commits are also durable on the linked runtime PR and main.

The native-failure archive contains its exact member-hash manifest. Preservation archives contain `PRESERVATION-INDEX.private.json`. The final index maps every logical path to its content hash, mode and archive carrier. Identical files reuse a previously verified carrier; original paths and modes remain separate. Restore a needed file from the named carrier and verify its index hash. A `recoverable_container_receipt` references an already preserved archive or bundle, not missing file data. `archive-index.json` records the verified carrier graph and exact receipt paths.

Snapshots have finite per-file cutoffs. They do not capture process memory or an atomic whole-machine/browser image. Standard dependencies and generated caches are reproducible from committed locks and setup. New closeout review/merge metadata is authoritative in GitHub and the containing records PR; the published scorecard is authoritative in boxes.dev. Those records are not recursively archived into themselves.

Keep restored raw logs, credentials and reference data private. Do not copy old machine identities, authentication sessions or configuration over an active environment. Preserve Freedom and all protected instructions. No deletion is performed by this closeout.
