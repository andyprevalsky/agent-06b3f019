# PR1749 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists the five private archives (core, workers, cloud, control, scratch)
with their immutable R2 object keys, hashes and sizes; [private-preservation-verification.json](private-preservation-verification.json)
records the independent authentication of every frame and member hash and a restore comparison. Deployed source:
`3e770c9e10be3ee23f6cf0a2ad4a523b1241789e`; validated head `79e007df49786d17071719477a283cbe8ed7b446`.
Never restore over a live checkout, database or browser profile.

1. Use a project workspace with its managed R2 configuration (`agents/.env`, `back-end/.env`). The archive key is
   escrowed in the project-managed ignored file `.context/pr1634-archive-recovery.env`, variable
   `PR1634_ARCHIVE_RECOVERY_KEY_B64`, and in `agents/.env` `TRACE_ARCHIVE_ENCRYPTION_KEY_B64`; the decoded SHA256 of
   both is `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`. Never print the value.
2. Use `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (Python 3.11 with boto3, cryptography,
   python-dotenv; `agents/venv` has them). It takes a receipt JSON; the receipt fields are in the manifest
   (`key`, `ciphertext_sha256`, `manifest_sha256`, `frames`, `files`, `stored_bytes`, `original_bytes`,
   `gzip_sha256`, `encryption_key_id`, plus `bucket: trace-archive` and `format: ROSE-PRIVATE-TAR-GCM-V1`).

```bash
mkdir -m 700 ../pr1749-private-recovery
python3 docs/handoffs/whm-b07d9037-preservation/private_archive.py verify --receipt <receipt.json>
python3 docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt <receipt.json> \
  --destination ../pr1749-private-recovery/core
```

Use an empty destination per archive. Members are named relative to `/home/boxes`; files that lived outside it
(`/var/tmp/rdw/<gate>/...`, `/var/tmp/li-*` including `/var/tmp/li-fix-clone/.context`, `/var/tmp/rca-sem-mobile`, `/run/boxes-memory-terminations.jsonl`)
appear under `pr1749-closeout-staging/<absolute path>`.

## Archives

- `core`: every staged-cycle state directory (`.context/deploy-pipeline` READY on 79e007df4, and the archived
  `.run1-20261107`, `.run1-20261107T0641`, `.run2-20261107T1117`, `.run3-20261107T1300-interrupted`), the review
  ledger and dispositions, approval batch state, `.context/li-goal` (RCA receipts and patches, approval packets,
  handoff packets, PR bodies, scripts, local run logs), deploy runs `20261107-030512-410782` and
  `20261107-064130-2393987` with `factory-events.jsonl`, local test runs, the local live LinkedIn run's browser
  recordings, trace outbox and rendered dumps, the `/var/tmp` RCA repro directories and logs, and the memory-watchdog
  termination log. `li-goal/run-sh.3.log` and `li-goal/AB-1749-4.*` contain bearer/presigned credentials; they exist
  only inside this encrypted archive.
- `workers`: gate evidence of the 11 worker roots under `/var/tmp/rdw` (`.context/{deploy-worker,cloudbench-local,
  test-runs,deploy-backend}`, `back-end/coverage`, `front-end/coverage`), including the already-archived
  `*.tar.gz` evidence and their `ARCHIVED-EVIDENCE.sha256` lists as-is.
- `cloud`: `.context/deploy-cloud` (the two live campaign directories, the seven archived campaign `*.tar.gz` and
  `ARCHIVED-EVIDENCE.sha256`) and this deploy's fleet teardown audits under `.git/cloudbench-fleet-audits`.
- `scratch`: the regular files of the scratch clone's `/var/tmp/li-fix-clone/.context` (approval batch state,
  test runs, trace-archive outbox), captured after the control archive.
- `control`: the capture file lists, `list-skipped.json` (symlinks with targets), the uploader receipts and logs,
  the restore comparison and the capture/generation scripts.

Worker checkouts, node_modules, venvs and databases are reproducible from the pushed commit and the documented
setup and are not archived.
