# WMH build and fundraiser benchmark: local continuation

Status: WIP snapshot on remote branch `codex/wmh-handoff-20261006` from the
cloud `porto-novo` checkout on 2026-10-06. This branch preserves its tracked
and untracked source changes. It is **not merged or deployed**. The October 1
`/deploy` of `a4b605f` was a separate change and did not ship this WMH work.
For a checkout from another branch, use the local Git worktree command in
`WMH_HANDOFF.md`. Portable run records and reports are included under
`docs/plans/active/wmh-evidence-20261006/`.

## Goal and user decisions

October 6 local continuation uses the isolated worktree
`/Users/andyprevalsky/Developer/rose-wmh-continuation`, branch
`codex/wmh-continuation-20261006`. Main `8ed0c776d` and portable handoff
`e5e0ff622` are integrated. The complete uncapped local rebuild finished on October 6: 12,519 real
trajectories and 179,169 eligible tool observations. Corpus structural sampling
passed all 100 examples across 47 tools and 10 categories. All 97 export
failures are explicitly recorded ciphertext checksum mismatches and remain
unresolved exclusions. Matching live inference conformance remains pending.

October 6 local verification: backend coverage passed all 184 blackbox domains
and 253 unit files, with 89.23% lines / 80.34% branches. Codex sandbox auth uses
an isolated test identity with the current authoritative auth file; no shared
integration was removed. Five cold seed-fidelity runs passed at 168–171MB,
under the unchanged 228MB bound. Full agent coverage subsequently passed all 109 blackbox domains,
181 Fast Cache tests, and 131 unit tests with 82% total coverage. Earlier
fixture failures and timeout observations remain recorded; no bounds were
relaxed. A controller mock's early stdin close has an owning red/green proof
and permanent stress regression; full controller validation remains pending.

The first exact fundraiser startup failed before agent creation because full
build persistence reintroduced Unicode JSONL separators. The native full-build
blackbox has unchanged red/green proof; full artifact normalization validates
179,449 index rows against the embedding matrix and escapes 13 records without
changing decoded content. The exact authorized run has been restarted; no new
fundraising or production outcome is established yet. See the October 6
full-build JSONL framing RCA.

Open operational TODO: cancellation of the first coverage stage after ENOSPC
left its bash controller holding the stdout pipe after npm exited. The exact
owned controller was terminated and cleanup finished. `run_deploy_stage.py`
currently skips signal forwarding when its direct child has exited; whether
that explains the retained descendant is unproved. Preserve this as an open
ownership/observability issue, reproduce with a direct child that exits while
its descendant retains stdout, then verify bounded cleanup without signaling
unowned processes. Do not report it as fixed.

Build the World Model Harness (also called WHM in the conversation) from real
archived tool results and make its simulation useful for the
`raise-5m-rose-labs-brex` benchmark. A valid run must show actual simulated
investor/lender commitments and at least $5 million arriving in the simulated
Brex account, grounded in tool observations. No real investor outreach or money
movement should occur in simulate mode.

- Root and general-purpose agent loops, including `for_each`, stay real. WMH
  supplies specialized explore/browser/code results and external environment
  boundaries. Browser simulation happens at the whole tool-call boundary.
- Corpus inputs must be real completed observations. Exclude DEMO and simulated
  trajectories before indexing; real non-DEMO benchmark trajectories are valid.
  Include completed steps from active runs, even before their final fixture is
  written. Do not impose an arbitrary 100-bundle cap. Pair agent-scoped calls
  with their latest terminal result and preserve per-action browser transitions.
- The synthetic fundraiser starting state says services are connected by
  default (including Brex browser access, Gmail `tamara@roselabs.ai`, and Tamy's
  SMS identity). Connectivity does not imply prior correspondence, investor
  interest, commitments, or deposits. WMH must return production-shaped results
  without inventing those facts.
- Use `rose-ultra` for the benchmark and `rose-1-ultra` for WMH predictions, as
  currently configured. DEMO-enabled WMH calls may write their own DEMO cache
  keys; clear the fundraiser's DEMO cache before comparative reruns and inspect
  hit/write metrics. Keep provider credentials out of persisted cache entries.
- The user authorized a **30-minute diagnostic run** after the 10-minute runs
  stalled. The catalog still declares 600 seconds; use the per-run
  `--timeout-seconds 1800` override for that diagnostic. Do not weaken the
  evaluator or silently extend the catalog limit. Earlier instructions saying
  to preserve a 600-second cap for every run were mistaken.
- Keep changes scoped to WMH and its benchmark path. Do not alter prompts or
  unrelated harness behavior to force a passing trajectory. Same-session WMH
  LLM predictions must overlap; retain the blackbox assertion for this.

## Snapshot and evidence

- Source snapshot starts at `a58f662a6` plus all dirty `porto-novo` files. On
  2026-10-06, `origin/main` was `33d2171e8` (327 commits ahead of that base).
  Integrate upstream carefully after preserving this checkpoint. No fresh full
  test suite or deploy gate was run for this WIP snapshot.
- Key code: `agents/benchmarks/world_model_harness.py` (archive selection,
  projection, conformance, model build), `serve_world_model.py` (retrieval,
  root session, parallel inference), `wmh_rose_provider.py` (Rose provider and
  DEMO cache), `run_benchmark.py`/`local.py` (simulation and reporting),
  `agents/helpers/world_model_runtime.py`, and
  `agents/benchmarks/tasks.json` (fundraiser contract).
- The generated model artifact `.context/world-model/` is about 1.7 GB and its
  binary index is **not on this Git branch**. The exact run records, corpus
  conformance, delta index, audits, and small model metadata are included as
  portable evidence files. The September 28 corpus conformance report passed:
  100 sampled examples, 7,264 trajectories, 10 categories, 42 tool names,
  103,519 eligible examples. The saved prediction score in `.context/` is from
  an older build; it does not validate this artifact or a new local rebuild.
- The September 28 10-minute simulated run
  `20260928_213636_raise-5m-rose-labs-brex` timed out with zero outreach and
  zero approvals. First-wave WMH browser predictions reported no verified
  submission/contact route. These are predictions, not proof about real sites.
- The September 29 **30-minute diagnostic** run
  `20260929_024443_raise-5m-rose-labs-brex` (root agent
  `89cb4dfb-551e-4dd5-a92c-94182274ef77`) completed after 22m27s but
  failed: $0 raised, no investor messages or applications, no commitments, and
  no Brex deposit. After an outreach child returned success with zero sends,
  the root moved to commitments and made 60 simulated daily funding checks.
  The completion verifier showed 100% progress despite the unmet goal. The
  recorded failure reason, `Expected approval requests but none were
  triggered`, reflects that no outbound action was attempted; investigate
  agent trajectory, WMH predictions, and evaluator separately.
- The user reported that the published Rose FE link for that run showed
  nothing: `https://www.roselabs.ai/?agent-id=89cb4dfb-551e-4dd5-a92c-94182274ef77`.
  This branch contains an archive-index lookup fix in
  `back-end/src/providers/benchmarkHubLookup.ts`, but it has not been deployed
  or verified for the user's viewing context. HTTP 200 or an admin-only view
  does not establish that the user can open the replay.

## Known boundaries to verify

- Same-session inference now snapshots under a short lock, predicts outside
  the lock, and commits under the lock; the Rose bridge shares one async loop
  so Fast Cache futures complete. Blackbox tests cover overlap and retained
  steps. The unchanged fundraiser still failed after these fixes. See
  `docs/rca/cases/2026-09-28-wmh-root-session-send-email-head-of-line-wait.md`.
- The provider now rejects blank or token-truncated WMH completions before a
  successful step is committed; the served boundary has a regression test.
  Recheck this against live model output. The related RCA remains open because
  the full benchmark has not passed:
  `docs/rca/cases/2026-09-28-wmh-blank-prediction-became-successful-explore-result.md`.
- Root goal and initial fixture hydration, and retention of the last good WMH
  usage/retrieval audit, have focused regressions. Their RCAs remain open
  pending an end-to-end passing run. Review the other WMH cases in
  `docs/rca/cases/` before changing routing or evidence capture.
- Earlier traces also contained a JSON-looking string where
  `spawn_general_purpose_agent_for_each.items` required an array, plus a
  browser result exposed as a nested `output` envelope. Determine whether
  either recurs; do not treat them as the cause of the no-outreach outcome
  without a reproducing trace.

## Continuation sequence

1. Read `CLAUDE.md`, `docs/testing.md`, and
   `agents/benchmarks/README.md` (World-model refresh conformance). Set up the
   local Mac environment using repo guidance. Do not use the Linux cloud-init
   command on the Mac.
2. Run focused tests: `agents/benchmarks/serve_world_model_test.py`,
   `wmh_rose_provider_test.py`, `run_benchmark_wmh_initial_state_test.py`,
   and `agents/tests/blackbox/world_model_harness.blackbox.py`. Preserve the
   parallelism and invalid-completion regressions. Then run the affected
   backend, agent, and deploy structural gates before proposing a merge.
3. Build/refresh WMH from the complete eligible archive and inspect the
   coverage/selection report. The cloud maintenance entrypoint, if used, is
   `bash scripts/run-bench-cloud --refresh-wmh --ref <pushed-commit>`; it fetches
   a commit, so new builder edits must be pushed first. Local builds use
   `update_world_model_for_simulation()` and the configured R2 credentials.
4. Serve the resulting model and run
   `python -m benchmarks.run_world_model_conformance` against its *matching*
   `conformance.json`. Require 100 successful calls, mean fidelity at least
   0.70, and mean content accuracy at least 0.25. Inspect category failures
   and exact retrieved real-world examples, not just aggregate score.
5. Clear the fundraiser's DEMO cache, then run the unchanged task in simulate
   mode with the authorized one-off override:
   `BENCHMARK_SKIP_WMH_DELTA=1 bash scripts/run-bench --local raise-5m-rose-labs-brex --simulate --timeout-seconds 1800`.
   Validate that the root/general-purpose agents remain real, external actions
   remain simulated, WMH cache writes/hits work, and the final $5 million claim
   traces to concrete simulated commitments and Brex deposits.
6. Repair and independently verify the Rose FE replay in the viewing context
   the user actually uses. Publish a durable run link and verify rendered
   messages; do not claim success from an admin-only view.
7. When the benchmark and affected tests pass, use the repo's `/deploy`
   workflow for review, merge, production rollout, and post-deploy gates. Keep
   the final report explicit about the commit, model artifact, corpus coverage,
   inference scores, benchmark outcome, FE replay, and production state.
