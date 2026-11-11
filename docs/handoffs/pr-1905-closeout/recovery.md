# PR1905 private evidence recovery

Use a separate devbox in the same project with its managed R2 and archive-encryption environment. The key is project-managed configuration, not a key kept only inside these archives. Never print or commit it. Use the project agents virtualenv with boto3, cryptography and python-dotenv.

Run the committed recovery helper with a receipt from the archive index and a new private target directory. It authenticates every frame, checks the complete compressed stream and every member hash, and recovers each historical snapshot separately. Prior snapshots are fetched by immutable receipt key and checked against the next receipt's recorded SHA256. The latest encrypted catalog distinguishes unchanged members from new snapshot members. Recovery never replaces an existing directory or the coordinator's deploy state.

The initial repair snapshot contains a verified complete Git bundle of inherited references, the original attachment receipt and private member manifest, and the original recovery helper. Verify the bundle with `git bundle verify`; fetch its references into a fresh repository under a preservation namespace. Exact branch tips and bundle hash are in the closeout manifest. The active repair branch is also retained on origin. No local or remote branch is deleted.

The separately authenticated original failure archive retains 23 parts and 1,948 members. Use its retained recovery helper, receipt and member manifest into another new isolated directory. Original chat PASS and publisher FAIL, source objects and clocks remain unchanged. Repair snapshots and new successful native runs do not reconstruct the absent original payloads.

All raw logs, environment configuration, private inventories, native prompts and signed evidence URLs stay encrypted outside Git. Public records contain source/merge bindings, tests, counts, original limitations and final outcomes. Generated dependencies and caches are reproducible; protected instructions and Freedom remain intact.

The archive index names committed full receipt files and their SHA256 hashes. Select the final receipt after closeout and pass that local receipt to the helper. Prior receipt hashes form an authenticated chain, so the helper independently fetches and restores each snapshot. The original 23-part receipt and recovery helper are retained in the initial snapshot attachments; they are separate from the repair archive chain.

```bash
agents/venv/bin/python docs/handoffs/pr-1905-closeout/recover_private_archive.py \
  --receipt docs/handoffs/pr-1905-closeout/archive-receipts/final-closeout-20261111T1824.json \
  --target ../pr1905-private-recovery
```

Replace the receipt label with the exact final entry from the committed index. Use a new target; do not restore old custody tokens or lease metadata into a live deploy.

The eight relative reference-tree symlinks are listed in `reference-symlinks.json`; their target regular files are verified in the authenticated catalog. The helper intentionally restores only regular archive members. Recreate these links only in an inspected, newly assembled private reference tree, using the recorded relative targets. Never apply that map over existing protected instructions or a live workspace.
