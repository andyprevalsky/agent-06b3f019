# PR 1634 preservation closeout

This records the deletion-readiness closeout for
[PR 1634](https://github.com/Rose-Ai-Labs/rose/pull/1634), deployed as
`172328eb96b9bf2a6b1ff6b0e81d1076d55253da`.

The original deployment finished with a recorded WMH task timeout. Its native
experiential engine and one automatic simulated notification were verified;
there were no task-selected environment actions. The task failure is retained,
not relabeled as a pass. The original closeout preserved the final deployment
records but left older local records unreconciled. That was insufficient to
promise that the devbox could be permanently deleted.

This records-only follow-up completes that preservation inventory and adds the
standing deletion-readiness requirement to `/deploy`. It does not change the
application runtime or repeat the failed benchmark.

The [closeout manifest](closeout-manifest.json) lists all 284 verified encrypted
objects. The [proof index](private-proof-index.json) locates the private inventories,
path metadata and recovery maps; [RECOVERY.md](RECOVERY.md) explains their use.
The [publication record](publication.json) binds the files in this directory to
the records PR and the original deployed PR.

The private verification files retain their pre-publication state: they require
the parent to merge and link this records PR. Those publication conditions are
satisfied by the final merged commit and its link from PR 1634, not by rewriting
the original verification receipts. The final completion message is issued only
after both conditions hold.

## Preservation contract

The committed closeout manifest is the index of record. Large/private evidence
and local configuration are encrypted outside Git; their immutable object
references, hashes, verified recovery evidence and key references belong in the
manifest. No credential, decryption key, signed download URL or private raw
transcript belongs in this directory.

A clean Git working tree alone is not deletion readiness. Every required local
record, including related worktrees, local-only commits, ignored files and
symlink targets, must be either represented in committed source or recoverable
from a verified durable archive. Reproducible dependencies and disposable
caches must have an explicit disposition rather than silently disappearing from
the inventory.

The final readiness record must prove recovery without the old devbox, including
archive decryption-key and local configuration recovery, and identify any
resource ownership transferred elsewhere. Missing or unclassified records keep
the closeout incomplete. The final `/deploy` scorecard is returned only after
this record is complete and merged, and is a promise that no later preservation
task is needed before deleting the worktree and local environment.

## Recovery without the original devbox

Use a separate private checkout of the commit containing this directory. The
archive index identifies each immutable encrypted object and encrypted receipt
sidecar. It also pins the helper versions and archive-key fingerprint. Preserve
that index independently of the old filesystem.

In another devbox in the same boxes.dev project, managed environment delivery
provides `.context/pr1634-archive-recovery.env` with
`PR1634_ARCHIVE_RECOVERY_KEY_B64`. The managed `agents/.env` and `back-end/.env`
provide the R2 connection values. The dedicated recovery value was saved to
project-managed storage, delivered back independently, fingerprint-checked and
used by a separate process to recover an existing encrypted archive. It is not
a key stored only inside the archive it decrypts. Never print or commit these
values. For recovery outside boxes.dev, obtain them privately from the project's
managed settings and use private configuration files.

Run the checked-in adapter with Python and the `boto3`, `cryptography` and
`python-dotenv` dependencies. It delegates framing, authentication, member-hash
verification and safe empty-directory restoration to the existing pinned
archive helper. It does not modify the configuration files.

```bash
mkdir -m 700 ../pr1634-private-recovery
python3 docs/handoffs/pr-1634-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  fetch-receipt --sidecar-key '<sidecar key from the archive index>' \
  --output ../pr1634-private-recovery/receipt.json

python3 docs/handoffs/pr-1634-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  restore --receipt ../pr1634-private-recovery/receipt.json \
  --destination ../pr1634-private-recovery/batch-001
```

Use a different empty destination for each archive. Authentication, wrong-key,
member-hash, nonempty-destination and path-safety failures must remain failures;
do not bypass them to complete recovery. The private inventory maps original
paths and symlink targets to their archived members or committed/reproducible
sources. Inspect recovered material before applying it to another workspace;
do not overwrite a live environment or restore old machine identity tokens.
