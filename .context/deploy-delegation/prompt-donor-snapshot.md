Run `/deploy` for branch `fix/cloudbench-donor-snapshot-refresh` of Rose-Ai-Labs/rose (already pushed, head abb62a25f, based on main a040520d5). You own it end to end: PR, review, merge, prod lanes, scorecard. I am the Claude agent in the "Benchmark Infra" thread (`ph7dq9mt5mnxgfx73j2xx6nrzs8fyme8`). I delegated this because my devbox is running a 50-task LIVE benchmark trial.

Setup on this fresh devbox:
- Read /home/boxes/rose/CLAUDE.md completely (or the repo checkout's CLAUDE.md). Follow "Cursor Cloud / Linux dev environment": run `bash scripts/cloud-init.sh`, then `git fetch origin && git checkout fix/cloudbench-donor-snapshot-refresh`.
- Then follow `.claude/commands/deploy.md` exactly.

What the branch does (6 commits). All of it comes from RCA of LIVE50 trial 1 on 2026-10-12:
1. `scripts/lib/agents_venv_satisfied.py`: location-only pip options such as `--find-links ./vendor` no longer mark agents/venv stale. This is cherry-picked from the WHM thread's d7b469917; its owning test is `scripts/tests/workspace-env.test.sh`.
2. `scripts/run-bench-cloud` `create_volume_snapshot_exact`:
   - re-reads a transiently empty pre-snapshot baseline
   - ignores snapshots Fly dated well before the request
   - waits, bounded, when Fly rejects a create with "snapshot is already scheduled"
   - fails closed on a lone already-complete candidate after an empty baseline
   - validates its attempt budgets
3. `--refresh-deps`: after acquiring the app lock, reuses a peer's exact proof written while it waited, instead of every queued controller redoing the refresh.
4. Measured budgets: snapshot readiness is now 180 polls, already-scheduled waits 120, and the app-env lock wait 3600s.
5. Test fixture: `test_refresh_deps_rejects_invalid_ref_before_fly` is now hermetic. Its token was under 20 characters, so it only passed with a real flyctl login.
6. Pre-service recipe 173053ec… is registered in `scripts/cloudbench-prestack-source-reviews.json`. An independent reviewer approved it; run-bench-cloud is the only changed recipe input.

The owning regressions are in `agents/benchmarks/cloudbench_dependency_sync_test.py` (`-k "refresh_deps or snapshot_baseline or already_scheduled"`) and `scripts/tests/cloudbench-app-env-lock.test.sh`. Lanes expected: CHANGED_AGENTS (4g), CHANGED_CLOUDBENCH (4cb, after 4g), and CHANGED_AGENTCARD_PAYMENT (agents/benchmarks/).

HARD CONSTRAINT: no paid verification overlapping my LIVE window.
- Do NOT run any LLM-spending or purchase lane until I message you "LIVE window clear". That covers Step 6 smoke, 6a AgentCard, 6b semantic, 6c E2B, 13b prod semantic and 13c prod AgentCard.
- Steps 0–4cb, Step 4p, PR creation, CodeRabbit review handling, and anything else that spends no model tokens are fine now.
- When you are ready for those lanes, message me with `dvb-onbox threads message --to ph7dq9mt5mnxgfx73j2xx6nrzs8fyme8 --message "..."`. Wait for my reply; do not poll. Keep doing non-paid work meanwhile.
- Do not merge before those lanes pass. Merge does not itself spend tokens, but it triggers prod deploys, and the prod lanes would follow.

Known devbox constraints:
- The boxes `gh` wrapper swaps in a token that cannot dispatch workflows or read deployments. Use the `GITHUB_TOKEN` from `agents/.env` with curl or the real gh binary.
- Export `ROSE_USE_SYSTEM_PG=true` and source `.cloud-env` in every deploy shell.
- There is no sqlite3, so skip the Conductor title steps.
- flyctl is at `~/.fly/bin/flyctl` and is not on PATH.
- Run Step 4p live probes only after all of Group 3 has finished. Running them concurrently deadlocks the shared local DB schema sync.
- Smoke and AgentCard append to `agents/benchmarks/history/*.jsonl`. Hold those rows aside (do not commit them mid-review); otherwise Step 0 re-adds lanes and the review-cycle ledger can be exhausted by main drift.
- If CodeRabbit is rate-limited, follow deploy.md's usage-exhaustion path. Do not ask the user.
- The tests `test_detached_script_snapshot_transfer_covers_exit_death_timeout_and_waiter_loss`, `test_autoscaler_stops_cleanly_when_its_benchmark_child_finishes`, `test_environment_mutation_is_maintenance_only_and_run_path_read_only` and `test_real_boot_driver_interrupt_requires_canonical_runner_cleanup_ack` fail in full-file runs on main too. They are stale and ungated, and no deploy selector runs them.

Rules:
- Never print secrets.
- Never kill other sessions' run-bench processes.
- Any human-approval request must paste the exact diff in chat, not file pointers.
- No prompt or LLM-visible text changes are in this branch.
- When done, post the deploy scorecard ending in READY TO CLOSE, and message me the merged SHA plus a one-paragraph result.
