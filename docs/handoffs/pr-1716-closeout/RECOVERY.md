# Recover PR 1716 evidence

PR1716 production source M is deployed. Final archival preservation is verified below. The actual records merge and final native factory outcome are resolved through Git main history and the originating PR1716 closeout link.

Create an isolated checkout and follow `CLAUDE.md` cloud setup with the project-managed files. Do not substitute sample environment files. The existing managed `.context/pr1634-archive-recovery.env` carries the escrow key; its expected SHA256 fingerprint is `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`. The key and R2 credentials must remain private. An independent devbox recovered all 58 initial members using only its existing managed configuration; no key was copied from this devbox.

Use the unchanged adapter `docs/handoffs/pr-1691-closeout/recover_closeout.py` and framing helper `docs/handoffs/whm-b07d9037-preservation/private_archive.py`. Run with the configured agents Python environment.

```bash
agents/venv/bin/python docs/handoffs/pr-1691-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key <receipt_sidecar_key from archive-receipts.json> \
  --output <new private receipt file>
```

Repeat the same common arguments with `restore --receipt <fetched receipt> --destination <new empty private directory>`. Each restored path is relative to `/home/boxes`; restoration authenticates every frame and stream hash and checks every member size and SHA256 against `MIGRATION_MANIFEST.json`. Use a new isolated tree, never an active project. The final delta will be partitioned to bound restore disk requirements; verify each part before retiring a reconstructed verification copy. Original evidence remains in the authenticated archive.

The closeout manifest indexes public receipts and private per-path inventories. All 11 physical bundle headers and hashes match both original manifests. The 116 prerequisite entries cover 72 unique commits, each proved ancestral to fetched main and M. See source-bundles.json for exact IDs and bounded proof. Fetch the recorded main history and verify those prerequisites before git bundle verify and import. Production M is 060fa655d16476e0ff84727bef5b4e188bee349d; validation C4 is 08f519dbfb1b782d403fa4d329a2cf8094606ea0. This records-only change is resolved through Git main history. Every recorded bundle is included in the authenticated final capture with its exact bytes/hash; source-bundles.json records that inclusion. Historical local-only backup source is preserved separately, without treating it as an intended release.

Current application configuration, caller overrides, worker bindings and the Fly configuration are private recovery records. Restore them for inspection before selecting configuration for a new environment. The treasury pending-mint ledger is an unresolved-obligation record: restoration or a warning skip does not authorize reclaim, deletion, refund or settlement.

Historical failed and UNVERIFIED outcomes remain unchanged. Current-local process closure is distinct from historical process-join proof and execution credit. Freedom and protected instructions and resources remain protected throughout recovery.

The encrypted final symlink inventory records logical paths and captured regular-file targets. Inspect those mappings before recreating links; do not point a new environment at old temporary paths. Reproducible directory links require their recorded Git/dependency source or an explicitly inventoried artifact directory.

The C3 failed raw-coverage checkpoint preserves one authenticated copy of each original raw member. Its encrypted `raw-union-recovery-map.json` also maps a byte-identical adapter union copy to those same members, allowing both original layouts to be reconstructed. Retirement of verified local copies did not change the original failed FPS verdict or grant validation credit.

## Verified prior checkpoints

These 11 entries retain existing authenticated readback claims; this preparation did not contact archive storage. Their exact object keys, sidecars and hashes are in archive-receipts.json. Final delta is verified in the archive index below.

- `core`: 58 files; manifest SHA-256 `4a97887616f5cb90bfd0ae6147c35fd9101f9e8e1a642b6acfb81bc233a92965`.
- `checkpoint`: 2188 files; manifest SHA-256 `d7e96c816908b05affab8bc69e83df6539b827234a84236a307a415038fcdd35`.
- `cloud-smoke-3cc`: 1129 files; manifest SHA-256 `cdaf3992f87e261dddf0dbbefc217352d2a7a5111dcd1743626d05b88aa1ba2e`.
- `cloud-smoke-a8`: 1136 files; manifest SHA-256 `9ea6334b2453b7487f33ba1528fe45515f03457528bed7b70f99067af53f9983`.
- `cloud-smoke-fe73`: 1194 files; manifest SHA-256 `89f69079411b49f07938af56d6e1397564699e86fffaef0eead5c8b0e2ee4964`.
- `late-core`: 8652 files; manifest SHA-256 `01d56c4576ece4c89013552406c880db7e80791be2abd2d369953ab22b46016e`.
- `cloud-smoke-1c0a`: 1326 files; manifest SHA-256 `1a72e9a5304db1a44d0c58c1dfacd38c44b36a6772df35246a91f014e1d95b91`.
- `cloud-smoke-ed47`: 1185 files; manifest SHA-256 `05b26ea442f48e84a2fd3bae867c0ce46142b2241ab2cd07cb24c1d69a7d847a`.
- `cloud-smoke-C2`: 1090 files; manifest SHA-256 `a183eb73b537cff531b56647d34a65d596e99fd9b6375e511a39176b20ba93bb`.
- `backend-C3-failed-raw-part-01`: 694 files; manifest SHA-256 `4ec309aa92b6ffd534ad325ed07e6df2c4bc0642d935acda497ddddda337d0f7`.
- `backend-C3-failed-raw-part-02`: 538 files; manifest SHA-256 `2a2b8bdb6d4f6a67e3525800258d8c06de7476bab2df75123c13cb8497367c50`.

Current full private environment snapshots, mappings and authenticated final recovery are complete. Never publish raw configuration, credentials, private native JSON, signed links or capability URLs. Preserve original run `20261106-043859-2259398` and start `2026-11-06T04:24:00.182421Z`.

## Completed final capture

The final18 parts plus metadata index are listed in archive-receipts.json. Restore each into a new empty private tree, authenticate every member, and use the index capture hashes/partition/already-covered maps to reconcile the116,911-path frozen capture. Prior archived matches remain available in the11 checkpoint objects. Later metadata versions are explicitly in the final index; retain each reconstruction separately before choosing its newer recorded mapping.

The64 actual environment copies are immutable400-mode private bytes with recorded logical paths/stat/hash observation boundaries. Their authoritative recovery map and symlink inventory are inside the encrypted archive. Managed ephemeral auth values may expire; refresh those through the project-managed secret configuration rather than assuming an old PAT remains valid. Current local closure is not a synthetic historical cleanup receipt. The final index deliberately does not recursively contain its own receipt; that receipt is in this reviewed Git record.
