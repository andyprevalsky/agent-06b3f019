# PR2174 closeout

[PR2174](https://github.com/Rose-Ai-Labs/rose/pull/2174) merged as `87d4c949b15c31d9b5c41a40bf91137090113f1a`. It deletes the released quarantine marker file for FLAKY `2d9047dbcd51485cbefa5d3d6dae614a`, `back-end/src/tests/blackbox/browser-session-provider-lifecycle.quarantine.ts`, and `browser-session.blackbox.ts` now calls `runBrowserProviderLifecycleCases` directly. No case, assertion or timeout changed. PR #2014 had already dropped the file's `quarantine()` wrapper; the repair goal names the file itself as the marker to remove.

Proof:
- Stability: the original handoff command (blacksmith-8vcpu, `deploy_test_worker.py`, all 271 checks) passed 5/5 on main `a1560dcf38`. Each run was 271/271 with `blackbox:browser-session` PASS and 0 FLAKY. Runs: 43678806067, 43678806055, 43678806276, 43678806354, 43678806212.
- Gates on `54816b5889`: 17/17 PASS. backend-coverage-blackbox was 271/271 with `blackbox:browser-session` PASS. Smoke ran with the AgentCard tasks elected out (disclosed in the PR body).
- Golden-reference review: GROUNDED. The deleted-test-file guard was cleared with that decision.
- Production on `87d4c949b1`:
  - Render: PASS (verified by descendant).
  - Backend probes: PASS.
  - Semantic: PASS, run [43690249365](https://github.com/Rose-Ai-Labs/rose/actions/runs/43690249365). The first dispatch failed with HTTP 403 (GitHub quota); it was rerun after the reset.
- CodeRabbit: `no-reviewable-paths` (path-filtered test files).

Related: the root cause was the gate VM's Postgres `max_connections`, fixed by `917e6bc6f` and recorded in #1971. #2124 makes the literal handoff command completable.

Private records are in the encrypted archive described by `private-archive-receipt.json`. Restore with `docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt>`.
