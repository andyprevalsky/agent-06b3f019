# PR1760 preservation recovery

[closeout-manifest.json](closeout-manifest.json) lists six private archives (core, workers, cloud, refs, stash, extra) with
their R2 object keys, hashes and sizes. Every one was read back in full and each frame authenticated at upload; the
`extra` archive was also restored into an empty directory and a member hash compared. Deployed `cdb8ce580`; gated
`6e347fb7f`.

Restore exactly as in [../pr-1739-closeout/RECOVERY.md](../pr-1739-closeout/RECOVERY.md) (same key escrow, decoded
SHA256 `e351c7cc5b01303e…`) with `docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt
<receipt.json>`; build the receipt from the manifest's archive fields. Members are named relative to `/home/boxes`;
files from `/var/tmp` appear under `pr1760-closeout-staging/var/tmp/...`. Never restore over a live checkout.

- `core`: every staged-cycle state directory (final `6e347fb7f` plus the superseded v1/v2a/v3/v4/v5/v6/v7 cycles),
  review/approval ledgers, deploy-runs, test-runs, the standalone gate's coverage logs, `/var/tmp/rdwplan` (repro
  harnesses, A/B scripts, load repro, triage/focus inputs, handoff packets, launcher scripts) and `/var/tmp/heaprepro`
  (report-bug repro logs), plus copies of the root-owned systemd service logs.
- `workers`: the eleven `/var/tmp/rdw/*/.context` local worker evidence roots and the retained loaded cloudbench fixture.
- `cloud`: every cloud smoke campaign under `.context/deploy-cloud`.
- `refs`: a git bundle of the 72 local branches with commits on no remote, and their tips (`branch-tips.json`).
- `stash`: a git bundle of the pre-existing stash entry `0e2ffe95` as `refs/preserve/stash-0`.
- `extra`: remaining ignored records (pre-fix `.llm-dumps`, trace-archive, benchmark-hub, storage shards, service logs,
  `agents/.env.benchmark-temporal`, agents/back-end `.context`).

Restore the branches with `git fetch <restored>/refs/local-unpushed-branches.bundle 'refs/heads/*:refs/heads/*'`.
