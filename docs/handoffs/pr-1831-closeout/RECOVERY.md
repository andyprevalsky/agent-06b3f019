# Private recovery

Use a fresh authorized project box with its authoritative managed R2 credentials
and existing trace-archive encryption key. The ciphertext objects and hashes are
listed in preservation-index.json; the corresponding private receipts are in the
terminal delta. Do not publish plaintext configuration, raw sessions or keys.

Restore into a different EMPTY directory for each object. The native archive tool
is docs/handoffs/whm-b07d9037-preservation/private_archive.py. Its verify/restore
operations authenticate every GCM frame, compressed stream, manifest and member
hash. The supplied range transport downloads a complete receipted ciphertext,
checks its byte count and SHA256, then calls that unchanged native restore.

```
agents/venv/bin/python3 docs/handoffs/pr-1831-closeout/restore_private_archive.py \
  --receipt /private/receipt.json \
  --destination /private/empty-restore \
  --native-tool docs/handoffs/whm-b07d9037-preservation/private_archive.py
```

The workspace base and application terminal delta have separate immutable scopes.
The delta also retains the original18-member failure attachment byte-for-byte.
Reconcile source paths and hashes using their snapshot/delta manifests; extract
only needed immutable evidence. Recreate dependencies and research clones from
published source and preserved patches. Keep current managed configuration and
live ownership authoritative. Existing archives, old task passes, cleanup claims
and row snapshots supply no new allocation permission or current financial state.

For the three protected allocations, preserve original ERROR/timeout/token and
financial snapshots independently. Use canonical identity-bound recovery only if
separately authorized. Never execute the original production benchmark, mint a
replacement allocation, flip Subscription mode or Stripe/cardholder keys, or
convert missing release/refund proof into a PASS. Why-user107-testmode remains
OPEN independently of the deployed admission guard.
