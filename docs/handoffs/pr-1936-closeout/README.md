# PR1936 closeout

[PR1936](https://github.com/Rose-Ai-Labs/rose/pull/1936) merged as `0f8f6da4461195bcc720481ef52375fa511f7fb1`. It repairs the cloud smoke INFRA_ERROR from PR #1927 round 6, where freshly cloned Machine `8d967d3f534068` never booted. After `machine update --skip-start`, Fly refused four starts within 17 s with `failed_precondition: machine getting replaced` and then `machine still active`, and nothing re-requested start. `boot_launch_start_after_config` now waits for Fly's `settled` state on the exact Machine and retries that precondition within a bounded 180 s window. Each response is classified on its own, and the ordinary 4-attempt budget is kept separate.

Proof:
- A repro replaying the provider refusals failed on `72186aa4d` and passed on the fix.
- New `cloudbench-env.test.sh` cases fail on the pre-fix and cycle-1 code.
- The original smoke task `agent-payment-new-user-journey` ran REAL PASS on `c465e7d47`.
- All 16 deploy gates passed on `ddd77137e`. Every boot-launched clone (17) had its post-config start accepted.

Remaining items:
- Cycle 2 merged unreviewed because of the confirmed CodeRabbit spending cap.
- The sandbox AgentCard release stall leaves $43.96 unreleased.
- The production AgentCard lane failed its preflight because there is no live KYC cardholder for identity 107; that change is user-only.
- Production semantic: `mobile-layout.spec.ts:194` FAILED in run 43085818750 and PASSED on its single rerun, run 43092615174, on the same merge, so it is recorded as FLAKY. The race repair is delegated: https://boxes.dev/thread/thr_36e63300c66b4921a608ea02e00b1415. Lane receipts are in `production-lanes.attempt1.json` and `production-lanes.attempt2.json`.

Private records are in the encrypted archive described by `private-archive-receipt.json`. Restore with `docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt>` into a new empty directory.
