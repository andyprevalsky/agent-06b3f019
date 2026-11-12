PR #1955 closeout: gate VM Postgres max_connections parity (repair of PR #1947 backend-coverage-blackbox/units)

Original failure: PR #1947 round 1, backend-coverage-blackbox (Actions run 43083582799, head fd8b1a14):
worker-deployment-queue.test.ts / workflow-restart-tools.test.ts, "Too many database connections opened:
FATAL: sorry, too many clients already". GitHub returned 5xx for that run's artifact on 2026-11-11 and the R2
result channel had already been deleted, so the original units.log could not be retrieved here.

Fix: scripts/ci/deploy-gate-setup.sh sets max_connections=300 (devbox parity), restarts, verifies.
Regression: scripts/tests/deploy-test-github.test.py GateSetupPostgres (deploy-command-structural gate).
RCA: docs/rca/cases/2026-11-11-gate-vm-postgres-stock-max-connections-below-coverage-pool-budget.md

repro/: local causal harness against a private PG16 cluster on port 5441 (initdb; max_connections 100 or 300):
  unitpass.sh <port> <label> [files]  real back-end/scripts/run-unit-tests.ts at gate parameters
                                      (BACKEND_UNIT_CONCURRENCY=6, connection_limit=16) + 0.5 s client sampler
  hold.sh <port> <n> <s>              n idle client sessions (stand-in for the coverage shards' Prisma pools)
  surge.sh <port> <delay> <n> <s> <label> <files>   mid-test surge
  backend-gate-build.py               builds the exact Blacksmith backend-coverage-blackbox request for HEAD

evidence/local-repro-summary.json: per-run exit, PASS/FAIL per file, sampled peak, "too many clients" lines.
  Clean fail/pass pairs: two-cap100-hold85/90/92 (workflow-restart-tools FAIL) vs two-cap300-hold92 (PASS);
  rerun-wdq-cap100-surge (worker-deployment-queue FAIL at workerDeploymentQueue.ts:135) vs
  rerun-wdq-cap300-surge (PASS, peak 106 clients). Caveats: the sampler cannot connect while the server is
  saturated, so saturated peaks read low; runs before the rerun-* pair copied coverage/unit-run wholesale, so
  their too_many_clients_lines may include stale logs from earlier runs (results.json is authoritative);
  wdq-cap300-surge started no load (path bug) and is superseded by wdq-cap300-surge2 / rerun-wdq-cap300-surge.
  The failing gate run's own connection peak was never measured; a passing main baseline measured cap 100,
  sampled peak 79 (sibling thread, run 42694223937).

evidence/backend-coverage-blackbox-manual-run.json: the original failing command with the fix, on this PR's
  frozen source (run 43100083158): 261/261 PASS; units log shows 392/392 unit files at concurrency 6, including
  both assigned files, and zero "too many clients".
evidence/smoke-agentcard-stall-triage.json: smoke agent-payment-abandonment standing AgentCard release stall
  (resource warning, never PASS; transfer owt_97a057db92ab833bc9f7f9dd 4396 cents unreleased).
