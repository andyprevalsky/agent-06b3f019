# PR 1716 preservation inventory

Scope: the browser pause RCA and its complete deployment on devbox
9c1dbe9c-0ecb-4b46-88fb-34c74ffbf3be. The only same-devbox thread discovered
was the coordinator; Git listed one canonical worktree. Isolated gate checkouts
under `/home/boxes/deploy-pause` are disposable validation copies, not additional
feature owners. Independent reviewer: boxes.dev thread
ph7e7k5yr6jwhmakprzsb8x8w58hhr57.

`initial-preservation.json` records authenticated private preservation of the
original production evidence, all initial failing/passing regression logs,
review packets and canonical configuration. The legacy helper verified every
remote archive member; a separate process fetched the encrypted receipt and
restored all 58 members with hash verification. No raw credentials or transcripts
are committed. The independent project-managed escrow file and exact key
fingerprint are documented by the existing PR1691 recovery adapter, which is
reused unchanged. Archive members retain paths relative to `/home/boxes`.

Disposition inventory:

- Intended frontend source, blackbox regressions, sanitized incident fixture and
  RCA case/index: committed in this PR.
- Original RCA runtime evidence, review packets, original failures and initial
  configuration bytes: encrypted private archive, verified by remote readback
  and a separate-process real restore; see `initial-preservation.json`.
- Staged validation attempts (including setup failures), final reviews, smoke
  campaigns and provider cleanup, production verification, scorecard and final
  factory publication: retained under `.context/` and each isolated worker;
  the post-deploy delta must be archived and linked by a reviewed records-only
  follow-up before claiming deletion readiness.
- Private env files are restored only into a new isolated recovery tree using
  the unchanged adapter at `docs/handoffs/pr-1691-closeout/recover_closeout.py`;
  never overwrite an active project. R2 credentials and the escrow remain in
  the project's managed configuration, independently of this disk.
- Dependencies, Python venvs, frontend builds, caches, empty/reseedable test
  databases and gate checkout source are reproducible from the reviewed Git
  commit, lockfiles and setup scripts. Retain their failure/evidence outputs;
  do not archive dependency binaries as unique source.
- Baseline inherited history/configuration is covered by the repository's
  PR1634/PR1691 preservation records. This task's new commits must all be on
  main before deletion readiness. No source or private record has been deleted.
- Freedom and protected instructions are preserved. No release, test or
  cleanup step authorizes modifying them.

This is the pre-release inventory, not a deletion-ready or shipped claim.
