# PR1956 closeout

[PR1956](https://github.com/Rose-Ai-Labs/rose/pull/1956) merged as `f50cdf459bca1daa017243be3c53fc9730f6fc81`. It closes the repair for FLAKY `ae9ae00ce96e4ceeb75d46cc9f1fa0c2`: `backend-coverage-blackbox/blackbox:integrations`, Lantern small-pool regression (`integrations.lantern-pool.cases.ts` `testLanternSmallPool`), with the error `Too many database connections opened: FATAL: sorry, too many clients already`. PR #1932 had quarantined it.

Root cause: the Blacksmith gate VM ran PostgreSQL's stock `max_connections=100`, while devboxes run 300 (`scripts/cloud-build.sh`). The sharded backend coverage pools stack up past that ceiling. The setup fix, which configures 300 before restart and verifies the live value (regression `GateSetupPostgres`, structural gate `deploy-test-github`), was written here as f76adfe10. It reached main first, byte-identical, through PR #1955 (423c51b8c). PR1956 removes the quarantine marker and adds the RCA case `docs/rca/cases/2026-11-11-gate-vm-postgres-stock-max-connections.md`.

Proof:
- Repro: `cd back-end && bash scripts/run-blackbox-tests.sh integrations` with 90 held clients and `max_connections=100` gave 49 FAIL "too many clients already", Lantern included, exit 1. The identical command at 300 passed, with a peak of 120 clients. It then passed 5/5 consecutive loaded runs unquarantined.
- Gates: 17/17 PASS on 7cca38051 and again on the final source 99098ac14. backend-coverage-blackbox on blacksmith-16vcpu passed 261/261 both times with the Lantern case blocking.
- Production on f50cdf459: Render PASS, backend probes PASS, production semantic run [43117727753](https://github.com/Rose-Ai-Labs/rose/actions/runs/43117727753) PASS.

Remaining items:
- Sandbox AgentCard release stall in round-1 smoke: `agent-payment-abandonment`, agent 6b76f2e0, org transfer `owt_96a8e50a5302cb3f6c766e3d` consumed with `releasedCents=0` ($43.96 unreleased, `livemode=false`). It was recorded as `resource_skip` / `agentcard_release_stall`, NOT_INTRODUCED, never PASS. Round 2 carried it as historical no-retry custody, so no new card was minted.
- CodeRabbit: cycle 1 was clean on 7cca38051. The sync delta had `no-reviewable-paths`.

Private records (repro evidence, deploy-cycle state and local-only template refs) are in the encrypted archive described by `private-archive-receipt.json`. Restore with `docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt>` into a new empty directory.
