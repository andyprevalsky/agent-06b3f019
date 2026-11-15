# PR2124 closeout

[PR2124](https://github.com/Rose-Ai-Labs/rose/pull/2124) merged as `dafb6e0ab32fec1e3477e958df10abaaf8ba4ff1`. With this fix, `scripts/deploy_test_worker.py` runs a recipe's declared shared `sweep` once. Before, it ran the sweep once per case. It is the FLAKY `2d9047dbcd51485cbefa5d3d6dae614a` repair's follow-up to [PR1971](https://github.com/Rose-Ai-Labs/rose/pull/1971).

Why it was needed: the repair handoff named the command `deploy_test_github.py --runner blacksmith-8vcpu-ubuntu-2404 --worker-script deploy_test_worker.py`. The backend-coverage recipe gives all 271 cases one shared `npm run test:coverage:sharded` sweep, and the generic worker ran that sweep serially, 271 times. At about 10 min each it could never fit the 4 h deadline. Run 43633983800 completed 27 sweeps, all PASS, before the workflow timeout cancelled it.

Proof:
- Regression `deploy-test-worker.test.py Worker.test_cases_sharing_a_declared_sweep_run_it_once` passes 5/5, and the full suite passes 198/198. After CodeRabbit cycle 1, the regression also asserts that case-specific FLAKY and quarantine rows stay with the case that recorded them.
- Gates: round 1 on 677f6f2927 passed 14/15, including smoke 11/11 with AgentCard and 0 AgentCard 401/429. Its `semantic-stack` gate was UNVERIFIED because the "deploy-gates workflow run never started". Round 2 on 7bdb0b9340 passed 15/15, including smoke 7/7 with AgentCard elected out (see the PR body disclosure).
- Production on `dafb6e0ab3`: semantic run [43677241579](https://github.com/Rose-Ai-Labs/rose/actions/runs/43677241579) PASS. It was the only applicable lane.
- The handoff command was run exactly as written (all 271 checks, phase initial, unfocused) on `dafb6e0ab3`, as run [43677257420](https://github.com/Rose-Ai-Labs/rose/actions/runs/43677257420). It exited 0: 271/271 PASS, `blackbox:browser-session` PASS, 0 FLAKY, no "too many clients", in about 13 min.

Review: CodeRabbit cycle 1 raised one finding, which was fixed. Cycle 2 merged unreviewed under a usage-cap skip (1 review/hour org allowance).

AgentCard election: the round-2 record binds ph7bsx6s "SKIP agentcard bs" because of a tool limitation. The actual authority is Andy, 2026-11-15 02:13:52Z (thread ph78a8d971dtx3xsknsnx8m7s98j1b57), "skip agent card tests". The withdrawn first election cycle was stopped in the quick phase and never produced a gate result.

Private records are in the encrypted archive described by `private-archive-receipt.json`. Restore with `docs/handoffs/whm-b07d9037-preservation/private_archive.py verify|restore --receipt <receipt>`. Template branches and the stash match the PR #1956 closeout archive tips.
