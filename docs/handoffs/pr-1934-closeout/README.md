# PR1934 closeout

[PR1934](https://github.com/Rose-Ai-Labs/rose/pull/1934) merged as `9e7fa01936c3e0f52f9e57213249474b9a76da95`.

## Assigned repair

The assigned repair was new-test-stability occurrence `4e2eb84f5fdf415d9da6ce9e54b04f8d`: `rose-ui-cli-browser.test.ts > check --examples passes every shipped example` failed with `particles-worker` worker p50 30 fps (min 55) under the gate's CPU load.

**Root cause.** `rose-ui check` decided whether the host was too busy to judge fps from the 1-minute load average, sampled before each entry. That average lags a host that just became busy.

**Fix.** Contention is now measured inside each fps window: `/proc/stat` busy ticks minus the check's own process tree. fps is reported `fps-inconclusive` only when other processes held more than half of the host CPU in every window. It fails closed to judging when the accounting is unavailable or untrustworthy. Budgets and every other rule are unchanged, and the quarantine marker was removed.

**Proof.**

| Run | CLI | Result |
|---|---|---|
| Cold 16-loop burst | unchanged | 2/2 FAIL with the exact original error (load/core 0.97, 0.99) |
| Cold 16-loop burst | fixed | 7/7 PASS. The worker was still starved to 30/20; measured other share was 0.83–0.89 |
| Quiet host | fixed | 7/7, including the janky and blocking-GPU negative controls. particles-worker was judged at 60/60 |
| Local stability gate, 8 load slots | fixed | 5/5 |
| CI new-test-stability gate on Blacksmith | fixed | 5/5 in every deploy round |

The RCA is appended to `docs/rca/cases/2026-11-03-worker-fps-failure-with-overlapping-deploy-lanes.md` (status fixed).

## Also shipped

**live-probes split into cases.** live-probes is now bound as one non-aggregate case per probe (`run_deploy_live_probes.py --only`), via `standard_template` and `deploy_gates.live_probes_recipe`. In round 1, one provider-side GLM failover miss (attributed NOT_INTRODUCED: OpenRouter's Morph host, the same miss seen on an unrelated branch) had made the whole gate UNVERIFIED and unwaivable. RCA: `2026-11-11-live-probes-bound-as-one-aggregate-case`.

**Sidebar fix carried in.** I cherry-picked `f81c18497b` with `-x`. That commit is main's PR #1929, already merged. It repairs three stale sidebar semantic specs. In round 2 those specs pushed semantic-stack past its 1800 s deadline, which recorded it as UNVERIFIED.

## Gate rounds

| Round | Source | Result |
|---|---|---|
| r1 | `951b4de` | live-probes UNVERIFIED (aggregate); semantic-stack FAIL (stale specs, NOT_INTRODUCED); smoke AgentCard stall |
| r2 | `e12acba` | live-probes PASS 6/6; semantic-stack UNVERIFIED (deadline); smoke AgentCard stall |
| r3 | `c79af61` | READY. All 16 selected gates PASS. Smoke had 12 PASS and 1 `SKIPPED_WITH_WARNING` |

The r3 warning is `agent-payment-abandonment`, the standing AgentCard release stall. It is never counted as a PASS.

Tests skipped (quarantined): 3, with 0 failed (non-blocking) and 3 passed.

## Production and review

Production lanes for `9e7fa01`:
- Render live, PASS.
- Backend probes 15/15 with a clean log scan, PASS.
- Production semantics, GitHub run 43079381500, PASS.

Not applicable (no changes in their areas): Fly, Vercel, the Mac release, WMH and the AgentCard production lane.

CodeRabbit hit the organization spending cap on all three heads, so PR1934 **merged unreviewed**.

## Financial warning

Each smoke round's sandbox abandonment run retained 4,396 cents transferred and 0 released:
- the card was closed with a zero balance;
- the purchase was HELD;
- funding was RECLAIMING.

The $43.96 per round sandbox obligation stays unreleased. No financial workaround was performed.

## Preservation

This deploy's local evidence is archived privately and encrypted in the trace R2 bucket. The public receipt is `archive-receipt.json`, which contains no key. The archive includes:
- the RCA repro data;
- three gate-cycle directories with Blacksmith artifacts;
- three smoke run directories;
- review and deploy receipts;
- RCA sub-agent attributions;
- the original CI failure artifact.

Restore it with the pinned helper `docs/handoffs/whm-b07d9037-preservation/private_archive.py`; see PR1918's `RECOVERY.md`.

The template-inherited local-only branch tips and stash are byte-identical to the tips already in PR1918's verified archive, so they are bound to that archive. Managed env files and template-era logs and caches are provisioned by the Template box or managed env and were not produced by this deploy.
