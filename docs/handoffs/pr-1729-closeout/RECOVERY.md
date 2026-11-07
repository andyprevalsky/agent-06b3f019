# PR1729 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists three private archives (core, workers, cloud) with their R2
object keys, hashes and sizes. Each was read back during upload and independently verified afterwards (every file
authenticated: 572, 1,972 and 4,686), and the core archive was restored into an empty directory and compared.
Deployed `308315a4bc`; gated `30409b901c`.

Restore exactly as in [../pr-1739-closeout/RECOVERY.md](../pr-1739-closeout/RECOVERY.md) with
`docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt.json>`; build the
receipt from the manifest's archive fields. Files from `/var/tmp/mobadv-rca` appear under
`pr1729-closeout-staging/var/tmp/mobadv-rca/...`. Never restore over a live checkout or database.

- `core`: every staged-cycle state directory (final plus five aborted cycles), timing runs, review ledger, approval
  batch, scorecard pointer, and `/var/tmp/mobadv-rca` (CI artifacts and logs of run 42191005446, Vercel deployment
  timeline, repro/regression Playwright outputs, cycle logs, production semantic logs, handoff packet, symlink list).
- `workers`: the three worker `.context` roots for the final cycle and the archived roots of earlier cycles.
- `cloud`: every cloud smoke campaign directory under `.context/deploy-cloud` (six campaigns).
