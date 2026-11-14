# PR1795 recovery

Use this committed records packet and the exact native deletion-readiness receipt. Restore into a new private directory or isolated checkout. Preserve Freedom and its protected configuration. Do not replay stale process locks, managed machine identities or teardown controls as live state.

## Authenticate and restore the archive carriers

1. Obtain the existing project-managed archive connection configuration and independently managed recovery escrow through the approved managed configuration channel. Keep values private. The decoded recovery-key SHA256 must match the fingerprint in `proof-index.json`; the matching escrow was independently verified. A key held only inside its own encrypted archive is insufficient.
2. From committed source, use `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (Git blob `592c092502cae2f08015858f98cdd1b5d436310b`, SHA256 `2e35e736660660bb6118a939d51b0dd008abe5efaa6387cf252d5d0536b75cf4`) and `docs/handoffs/pr-1634-closeout/recover_closeout.py` (SHA256 `0c469e18e5b391bedc53669781e2633145d564156476955097be51ec554afe32`). The adapter supplies configuration; the unchanged helper performs framing, authentication and safe restore. Use the project's pinned Python environment and dependencies.
3. Read each raw receipt directly from this records packet. These receipts need no encrypted receipt sidecar. Check the raw receipt SHA256 against the proof index before use. Invoke the existing adapter's `verify` and `restore` commands with that receipt and the private managed configuration files. Use a separate empty destination for each archive; never overwrite another historical version.
4. The helper authenticates every frame, ciphertext/gzip stream and outer manifest member. Then check the restored payload and private inventory hashes against the proof index. The payload is a nested tar; its private inventory records inner member hashes, sizes and modes. Restore only selected members into an isolated namespace and verify their hashes and metadata. Keep literal links as provenance until their targets are safely translated into that namespace.

The adapter accepts these arguments without requiring a new archive protocol:

```text
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py
  --config PRIVATE_MANAGED_CONFIG_1 --config PRIVATE_MANAGED_CONFIG_2
  --escrow PRIVATE_MANAGED_ESCROW
  --key-fingerprint FINGERPRINT_FROM_PROOF_INDEX
  verify --receipt RECORDS_PACKET_RAW_RECEIPT

python3 docs/handoffs/pr-1634-closeout/recover_closeout.py
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py
  --config PRIVATE_MANAGED_CONFIG_1 --config PRIVATE_MANAGED_CONFIG_2
  --escrow PRIVATE_MANAGED_ESCROW
  --key-fingerprint FINGERPRINT_FROM_PROOF_INDEX
  restore --receipt RECORDS_PACKET_RAW_RECEIPT
  --destination NEW_EMPTY_PRIVATE_DIRECTORY
```

These are argument templates: substitute private file locations without printing values or adding them to Git. Receipt authentication, wrong-key, unsafe-path, nonempty-destination and member-hash errors remain failures.

## Recover source and final path metadata

Recreate exact recorded main history `436727a0e6bde5e77d4463f246d8bf87618ca15b` in a new repository. Verify and import the prerequisite supplement, then the local-only tip bundle, using the sizes and SHA256 values in the proof index. The static encrypted inventory retains the exact advertised refs and tips. A clean main-only recovery verified 72 branch tips, one stash, prerequisite ordering and `git fsck` without borrowing an alternate object store. Recover later published source and records commits from Git separately.

The verified final private closure map selects each logical path's exact earlier or final archive carrier, content hash, mode and link metadata. A repeated content hash permits reusing bytes; it does not permit copying another path's mode or assuming hard links. Recreate documented dependencies and generated caches from recorded setup/source evidence. Physical cleanup reserves are reservations, not user data; retain their qualification and metadata. Never restore archived native custody files as permission to stop resources.

## Local database recovery

The private local capture contains 17 native PostgreSQL 16 custom-format database dumps and a separate globals SQL file. Each database has its own consistent snapshot; no cross-database atomicity is claimed. All custom dumps passed native archive listing. Per-file hashes, database metadata and capture counters remain in the private inventory and are bound by the verified final archive.

Restore selected databases only into a new isolated PostgreSQL 16 instance using `pg_restore`, after verifying the private dump hash. Review globals SQL privately before applying it to that isolated instance: it contains role data and is not a script for production. Never print its contents or overwrite an existing cluster. The final cutoff must refresh the capture if local database membership, writes or global settings changed after the recorded snapshot.

## Stop the publication chain at durable Git records

The data cutoff fixes the required private evidence and final renderer/input/QA snapshot. The final archive is uploaded and independently verified against that frozen map. Its raw receipt, compact proof binding and terminal publication metadata necessarily come afterward. Commit those sanitized outputs directly in the records-only follow-up and link that merged record from the deployment record. Record the final source/records commits and published visual terminal pointer through that durable publication chain.

Do not repeatedly archive a new receipt merely because it describes the previous archive. Git is the carrier for these sanitized receipts and post-cutoff PR/visual metadata; the immutable encrypted objects remain the carriers for private payloads. Keep the captured renderer/input/QA bytes distinct from later publication identifiers. Final status, elapsed-time fields and publication identifiers are derived from the committed receipts and retained by the permanent visual/PR publication; they are sanitized terminal metadata. If publication changes required private data or the frozen private renderer/control inputs, reopen the cutoff for that explicit changed scope rather than claiming it was already captured. Final native readiness still requires the parent's actual source/ref/process/ignored-path checks and completed records publication.

The final native-production proof index separately binds the canonical exact-merge worker cutover,45-case migration matrix, five semantic checkout proofs, descendant-backend retention and read-only schema verification. The original automatic transport FAIL and original AgentCard FAIL remain historical facts; recovery must not relabel them as successful runs. The normal workflow was later re-enabled by its release owner for future deployments.

## November 14 configuration supplement

The original three archives remain immutable. Restore `archive-receipts/backend-env-20261114.json` with the same authenticated helper and managed key into its own empty directory, then verify `backend-env-verification-20261114.json`. Its two members are `backend-env.private` and `private-manifest.json`; the latter binds the former to the backend environment path, byte count, mode and content hash. Apply this newer configuration only in an isolated recovery directory after recovering the historical closure. Never print its contents or replay it into production. The dated resume verification proves no new or missing private paths and only the required configuration plus terminal scorecard pointer changed.
