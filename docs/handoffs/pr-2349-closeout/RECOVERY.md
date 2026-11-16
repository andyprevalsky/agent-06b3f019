# PR2349 private preservation recovery

The immutable preliminary base and final delta use existing AES256-GCM framed archives in the private trace-archive R2 destination. No raw transcript, local configuration value or decryption key belongs in these public records. Obtain the existing project-managed configuration privately; never source dotenv files. Existing independent key escrow is .context/pr1634-archive-recovery.env; decoded key SHA256 is e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730. Do not print key values.

Use the pinned docs/handoffs/whm-b07d9037-preservation/private_archive.py (SHA256 2e35e736660660bb6118a939d51b0dd008abe5efaa6387cf252d5d0536b75cf4), with the project Python environment (boto3, cryptography, python-dotenv). The helper reads agents/.env then back-end/.env. Verify each sanitized receipt, then restore each archive into its own NEW empty private directory:

    agents/venv/bin/python docs/handoffs/whm-b07d9037-preservation/private_archive.py verify --receipt BASE-OR-FINAL-RECEIPT.json
    agents/venv/bin/python docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt BASE-OR-FINAL-RECEIPT.json --destination NEW-EMPTY-DIRECTORY

The existing docs/handoffs/pr-1634-closeout/recover_closeout.py adapter can perform verify/restore using separately delivered escrow with --recipe, --config agents/.env --config back-end/.env --escrow .context/pr1634-archive-recovery.env --key-fingerprint as above. This is a separate bootstrap from the encrypted contents, not a key stored only inside its own archive.

The private-proof-index.json file identifies the authenticated private source-member maps. Read those authenticated maps only after restore; they bind each original path and size/SHA256 to an exact base or final archive member. A base-reused file must be recovered from its base member. Keep original modes and symlink text as provenance; do not create links into a live original filesystem or overwrite current environments. Ignore numeric source ownership when rebuilding under a new authorized user.

For source recovery initialize a NEW bare repository, import the restored preliminary base.bundle, verify and import restored final-delta.bundle, then verify every frozen ref/tip from the private final refs-before.txt. Branch tips unchanged from the base need not be advertised by the delta. Verify the combined graph, including reflog identities. Recreate only deliberately chosen refs in the new repository. Original pruned-reflog warnings remain disclosed; successful recovery of current reachable objects does not reconstruct absent historical objects.

Frozen final cutoff is 2026-11-16T17:35:33.979166Z, records HEAD6841639be56ade6adf0c0d9c3fc17867fb8eeb3e; primary deploy merge457cc757d706bad1360fe89876a1b4a79b820d3a. Later public PR2409 records, CodeRabbit ledger and final publication commits are after-cutoff records recovered from GitHub, not claimed as private archive bytes. Recreate dependencies, caches and reference harnesses through recorded setup instructions. Temporary archive staging, empty-restore checks and verification Git databases are redundant derived outputs, not separate evidence.

This archive recovery record does not itself assert deletion readiness or authorize any deletion. The parent owns the native deletion-check and publication. Freedom and protected instructions must remain preserved.

Cited reference bytes are in the separate reference archive receipt. Bulk vendored trees have unknown clean state; reference-provenance.json reports their actual .ref-sha markers rather than enclosing repository HEAD. Exact locally cited source files and markers were separately hashed, encrypted, independently verified and restored. The final private-proof-index points to the authenticated map; the public map does not contain transcript or credential values.
