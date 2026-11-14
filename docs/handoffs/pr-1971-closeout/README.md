# PR1971 closeout

[PR1971](https://github.com/Rose-Ai-Labs/rose/pull/1971) merged as `051806597b6f2e0a752f2131e43ced43b906302e`. It closes the post-merge repair for FLAKY `2d9047dbcd51485cbefa5d3d6dae614a`: `backend-coverage-blackbox/blackbox:browser-session`, provider-lifecycle section (`Error: worker failed before ready: PrismaClientInitializationError: Too many database connections opened: FATAL: sorry, too many clients already`), from PR #1928.

Root cause: the same one as `docs/rca/cases/2026-11-11-gate-vm-postgres-stock-max-connections.md`. The gate VM ran Postgres's stock `max_connections=100` beneath the sharded coverage peak. The failed source `cfa06656` predates the fix `917e6bc6f`. PR1971 appends this occurrence and its evidence to that case. The quarantine marker was released on main by `1867d41945` (PR #2014), so PR1971 carries no code change.

Proof:
- Repro on an isolated PG16 cluster with 95 held clients: cap 100 refused the provider-lifecycle fixture with `too many clients already`; cap 300 passed. The section passed 5/5 consecutive runs, peaking at 6 clients itself.
- Five concurrent Blacksmith runs of the original `backend-coverage-blackbox` command on the marker-free snapshot `e220fbc10` each passed 261/261, with `blackbox:browser-session` PASS, 0 FLAKY and 0 `too many clients`. Runs: 43124597628, 43124612430, 43124613556, 43124612387, 43124612974.
- Gates on the final HEAD `fc44ebc83`: 6/6 PASS. CodeRabbit: `no-reviewable-paths`, because `docs/**` is path-filtered.
- Production on `051806597b6f`: semantic run [43632582207](https://github.com/Rose-Ai-Labs/rose/actions/runs/43632582207) PASS. No other lane applied.

Private records (repro logs, gate results and deploy-cycle state) are in the encrypted archive described by `private-archive-receipt.json`. Restore it with `docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt>` into a new empty directory. Template branches and the stash match the PR #1956 closeout archive tips exactly.
