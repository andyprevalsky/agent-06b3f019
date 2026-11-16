# PR #2406 preservation closeout

**Terminal repository evidence is archived and verified.** The readiness record is finalized in the records-only follow-up linked from PR #2406. No devbox deletion is requested.

The local merge receipt binds PR #2406 to `3128d97a94d247a5da95028745727caa6138d0aa`, reviewed source `52ab8b1c6ee46eff2312d4f133ef80879d76c5fe`. The branch `fix/agentcard-purchase-consumed-lifecycle` remains preserved. Parent `ph753gc8dcsya1w981xkm6ed9d8jajvr` supplied terminal production PASS and successful finish retry; both the original finish failure and successful retry are archived. No production monitoring or payment tests were performed here.

The [manifest](closeout-manifest.json) binds the terminal evidence to a private AES-GCM archive: **34,297 files, 3,104,063,730 original bytes, 740,157,007 encrypted bytes**. [Verification](final-archive-verification.json) establishes complete authenticated readback, isolated restore, exact selected-member coverage, independent source hashes and unchanged source metadata after hashing. All 311 regular target files behind the recorded inventory symlink are covered; its literal mapping is preserved. Archive outputs and restored copies are excluded to prevent recursion.

[All 73 local-only refs](inherited-ref-verification.json) match exact prior archived tips. All three inherited archives were freshly reverified with their established helpers. No ref was removed. The inventory-only archive remains separately labeled; it is not substituted for terminal evidence.

The recovery environment file `.context/pr1634-archive-recovery.env` and normal environment files remain in place and are excluded from trace capture. Parent confirms existing managed-template delivery. No independent replacement-devbox delivery test is claimed and no key value is present in these documents.

Recovery commands from a private checkout with managed R2 configuration:

```bash
PYTHONDONTWRITEBYTECODE=1 agents/venv/bin/python -I docs/handoffs/whm-b07d9037-preservation/private_archive.py verify --receipt docs/handoffs/pr-2406-closeout/private-archive-receipt.json
PYTHONDONTWRITEBYTECODE=1 agents/venv/bin/python -I docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt docs/handoffs/pr-2406-closeout/private-archive-receipt.json --destination .context/pr2406-recovery/closeout/new-empty-restore
```

Helper SHA256: `2e35e736660660bb6118a939d51b0dd008abe5efaa6387cf252d5d0536b75cf4`. The helper authenticates every frame and member hash and refuses nonempty restoration destinations. The private archive contains selected-file metadata and explicit secret/symlink dispositions. The six-member preliminary inventory snapshot also passed readback and isolated restoration.

Read [FOLLOWUP.md](FOLLOWUP.md) for remaining work. No source edit, checkout, commit, push, merge, cleanup, process kill, teardown, deletion, Freedom change or instruction change was performed by this worker. Broader home/system/runtime preservation is outside this archive's certification.
