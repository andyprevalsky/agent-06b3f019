# Recovery of PR #2347 records

Use the existing archive utility at `docs/handoffs/whm-b07d9037-preservation/private_archive.py`, with the documented `agents/venv` and authoritative managed environment. The archive receipts contain object metadata, never encryption credentials. Existing R2 and trace-archive encryption configuration must be restored through the project's managed environment before recovery.

For each receipt, independently restore into a new empty private directory:

```
source agents/venv/bin/activate
python -I docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt <receipt.json> --destination <new-empty-directory>
```

Each archive authenticates its own manifest and every member. Private origin/hash catalogs map members back to their exact original paths. Objects can contain different preserved versions of the same logical path; select deliberately using recorded hashes. Do not restore over the live checkout or merge versions automatically.

The preparation archive has 107 members; the initial evidence supplement has 16,476; the completed final-gate supplement has 14,289. All three have full authenticated readback and independent empty-directory restore/hash verification. The final archive has 5,404 members and binds all remaining unique evidence plus recovery support. A 32-member late-proof archive separately preserves verification reports and private per-file proof catalogs created after that upload. Every archive has full readback and independent restore/hash verification.

The inherited Git archives cover exact branch/stash tips through the manifest's object key and ciphertext hash bindings. Restore Git bundles only in a recovery workspace with the documented origin/main prerequisite. Do not delete or move live refs to make this checker pass.

Inventory symlink text and stable target files are preserved in private metadata. A runtime FIFO is represented by metadata and regeneration disposition, never captured by reading its stream. Private recovery environment material remains encrypted; do not copy it into repository documentation.

Later verification and publication metadata created after a capture cutoff must be committed or separately preserved. The archive summary identifies each cutoff and proof so later bytes are not mistakenly claimed as archived.
