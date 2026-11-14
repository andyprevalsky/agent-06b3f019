# Historical component verification receipts

The component checks described in `docs/agentcard-review.txt` predate the final
release. Their private evidence is preserved in the `settled-reviews-part01`
archive. This is historical verification evidence, not a new-source or production
PASS. Current deployment and production verification remain separately required.

The committed [archive receipt](component-verification-archive.json) identifies
the exact encrypted object, ciphertext and manifest hashes. The object contains
896 files (12,032,875 original bytes), including the `rose/.context/agentcard-review/`
receipts and their original source/test records. The member map stays inside the
private archive. No credentials or raw private evidence are committed here.

The existing uploader completed authenticated full-object readback, separate
verification, and a separate-process restore using the existing managed escrow.
All selected restored member hashes, sizes and modes matched. This was recovery
in a new empty directory on the same devbox, not a fresh-devbox recovery claim.
Original source files were retained and unchanged. Later deploy/production
records and whole-devbox deletion readiness are outside this component receipt.

## Recover from a fresh checkout

Use the project's independently managed archive credentials and existing recovery
escrow. Do not copy keys into commands or Git. Restore into a new empty private
destination, preserving the original files and configuration:

```sh
agents/venv/bin/python docs/handoffs/pr-1634-closeout/recover_closeout.py \
  --recipe docs/handoffs/whm-b07d9037-preservation/private_archive.py \
  --config agents/.env --config back-end/.env \
  --escrow .context/pr1634-archive-recovery.env \
  --key-fingerprint e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730 \
  restore --receipt docs/handoffs/pr-1864-closeout/component-verification-archive.json \
  --destination /home/boxes/private-agentcard-component-recovery
```

The restore helper authenticates the stream and verifies member hashes. Receipts
are under `rose/.context/agentcard-review/` in the restored destination. Access to
the private archive requires the project's authorized managed credentials.

## Review stabilization verification

The [review1 archive receipt](review1-component-verification-archive.json) preserves
365 settled component members (16,081,164 original bytes): accepted patches,
registered regressions, causal RED/GREEN records, source/hash/mode manifests and
actual shared-source validation on commit08e0666. It includes the v2/default-last4,
27-case issued-ledger and TypeScript proof, provider19/worker40/client33 checks,
full97-case cleanup proof with its retired disposable PostgreSQL fixture, and
the agent fixture/funding checks. Private member maps remain encrypted.

Upload with authenticated full readback, explicit verification and a new empty
separate-process restore using the existing managed escrow all passed. All365
restored hashes, sizes and modes matched; all originals retained their bytes,
sizes, modes and modification times. This was recovery on the same devbox,
not a fresh-devbox recovery demonstration.

Use the recovery command above with receipt
`docs/handoffs/pr-1864-closeout/review1-component-verification-archive.json` and a
new empty destination such as `/home/boxes/private-agentcard-review1-recovery`.
The restored paths retain their original `rose/.context/agentcard-stability/`
component scopes. Full source/dependency trees are not included: use pinned Git
and the normal dependency setup. Superseded3e97 candidate bytes were reconstructed
at preservation time from pinned Git and its immutable patch and checked against
the original manifest; this is not a historical snapshot or physical-mode claim.
Earlier reused log paths without recorded historical hashes contain only their
preserved cutoff bytes. No earlier raw version is invented.

This packet excludes active deploy/image/setup, live onboarding, production and
later control records. It supplies no native E2E, deployment or whole-devbox
recovery/deletion-readiness credit. Those final records remain separately required.
