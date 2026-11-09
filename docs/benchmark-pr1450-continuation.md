# PR #1450 continuation checkpoint

Updated October 8, 2026. Read the current `CLAUDE.md` completely first, then
`AGENTS.md`, this checkpoint, `.claude/commands/deploy.md`,
`.claude/commands/benchmark.md`, `.claude/commands/rca.md`
and `docs/rca/process-feedback.md`.

## Branch and workspace

Continue [PR #1450](https://github.com/Rose-Ai-Labs/rose/pull/1450),
**Preserve evaluated benchmark verdicts and bound infrastructure retries**, on
`codex/final-source-deploy-checkpoint-20261008`.

The existing checkout is
`/Users/andyprevalsky/Developer/rose-final-source-deploy-checkpoint-20261008`.
Runtime verification below belongs to source
`7d9426189546d72268c6dd1da473724f0f31cffc`; this continuation commit changes
documentation and the reviewed historical RCA archive. Revalidate the current
branch and external state before acting.

`/Users/andyprevalsky/Developer/rose-pr1299` holds private campaign/dashboard
state and unrelated dirty benchmark history. Preserve that history. Use the
Developer checkouts; the Desktop checkout is stale. Existing dependencies and
setup are usable. Keep canonical env files under
`/Users/andyprevalsky/conductor/repos/navi-whisper-lux-v2/`, their relative paths
and matching `BACKEND_API_KEY`. Keep Freedom and all its protected configuration
intact. Never publish secrets, raw trajectories, request bodies or forensic logs.

## Exact remaining goal

**Acceptance is 0/5. Deployment is incomplete.** Complete five consecutive
qualifying runs, each with 50 distinct random eligible DAILY tasks. Tasks may
repeat between runs. Each fresh-context runner reads `CLAUDE.md`, makes and
pushes a harmless source comment, then uses the supported CLI with a genuinely
uncached image build. Demo replay and recovery are diagnostic evidence.

- Temporarily set task execution to 1,200 seconds. Keep normal defaults intact.
- Use one 5,400-second whole-experiment deadline, measured from the original
  uncached image start through evidence publication and complete resource
  release. Include retry, recovery and intervening time in that same clock.
- Retry infrastructure failures only, at most once per logical task, after the
  previous attempt's exact owned resources are released. Healthy peers continue.
- Genuine task PASS or FAIL, including execution-window FAIL, may qualify.
  Require meaningful completed LIVE calls where sensible; chat/early outcomes
  may need fewer. Do not add calls to satisfy a counter.
- Require terminal outcomes, complete durable evidence and correct release of
  processes, browser/provider sessions, workflows, Machines, volumes and claims.
  Use internal latency/stage targets as diagnostics, with generous bounds.
- Check correlated completed LLM calls and latency/concurrency for actual
  parallelism problems. Replay, partial streams and recovery are not LIVE credit.
- Keep each run as one 50-task frontend group, with original timestamp and all
  states; publish task verdicts promptly before teardown completes.
- An unqualified run resets the consecutive streak. Reset earlier credit for a
  runtime change only when it invalidates that evidence; verified documentation,
  test-only and harmless-marker changes do not reset credit.
- Cement concise owning regressions in normal deployment. Preserve the actual
  task/model/prompt/evaluator results and avoid a massive verification expansion.

Use the current LIVE50 recipe in `CLAUDE.md` and the full CLI README. Important
settings are `BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS=1200`, `--timeout 1200`,
`--retry-infra 1`, `--concurrency 50`, `--strict-barrier`, `--e2e-timeout 5400`
and `--e2e-started-at` bound to the original image-start epoch. Use
`scripts/run-bench image-build --builder depot --no-cache` and exact image
activation. Preserve the CLI's printed monitoring/recovery instructions.

## What is verified

At the frozen runtime source above:

- Normal complete command registry: **45/45 passed**, including compact
  benchmark checks: **530 passed, 4 intentional skips**.
- Lifecycle aggregate repair: unchanged reproduction 4 failed/3 passed before
  repair, 7 passed after; owning family and independent family each 20 passed.
- Retry disposition repair: 2 failed before, 2 passed after; 12 retry/clock and
  10 independent scheduler checks passed.
- DEMO fixture dependency repair: both owning and independent full families
  passed 19 tests without removing assertions, feed or cleanup.
- Frontend normal coverage: 2,668 passed, 3 intentional skips. Backend/agents
  coverage qualification is explicitly source-bound, not a new whole-suite run.
- Actual native recipe: 39 entries/36 unique bindings, certified executable
  fingerprint `f1288b99c0b3cc1b8b89fd655fc0427d9874cf790ae5aaee90dc0b661f346501`.
- Independent review rejected an automated outside-diff startup-flag concern;
  the existing unchanged `infra-strict` retry case passed. No fix was justified.

Current public code, regression registration and CLI guidance are on this PR.
The latest checkpoint's paid and production deployment gates still need to pass.
Earlier merged/deployed checkpoints do not prove this source or the five runs.

## Failed deployment attempt and exact custody

Original local smoke: 2 PASS, 5 FAIL, 1 credential SKIP. AgentCard: 1 PASS,
3 FAIL. Semantic UI: 8 PASS. The chat-20 lane exited with its normal retained
stack wait guard; **zero chat samples started**. Real Claude Code E2B passed;
its three exact sandboxes were independently verified absent.

Native Mac logs show 187 seconds of clamshell suspension and 906 seconds of
maintenance suspension across the failed execution. Each spawn, parallel and
payment task has separate evidence. Payment's own traceback records a heartbeat
timeout. Reported client/span elapsed is distinct from wall time and provider
execution. All unchanged awake-host outcomes and original Temporal attribution
remain open; the updated historical archive records these gaps explicitly.

Five additional Agent rows committed before a failed workflow-start response
were discovered. A missing returned ID was not zero allocation. Exact native
Temporal queries used the existing controller after namespace/key agreement:
three remaining RUNNING executions were terminated with original run/queue
identity checks. All **11 original roots** subsequently had canonical sealed DB
trees, provider release and zero pending payments. Original failures retain
zero acceptance credit.

The final local stack cleanup receipts remained pending when the old owner
stopped. A handoff observation found the recorded stack/dashboard PIDs and
original service listener ports absent; this does not prove every descendant or
Docker resource absent. Reconcile native inventory and receipts without
rewriting the original outcomes. The existing controller is
`rose-pr1299-controller-20260913-3bd0bf6d`, Machine `3d8d023dc05d58`; preserve its
owned volume and verify its current parked state before use. At 4:57 PM PST on
October 8, the handoff owner verified zero campaign processes, stopped that exact
Machine, and observed native `stopped` with owner/config/mounts unchanged.

Private receipts are in the PR checkout's
`.context/final-composed-deploy.private/`:

| Receipt | Scope |
|---|---|
| `repaired-complete-command-registry.safe.json` | Actual full 45-command execution |
| `root-cycle2-startup-flag-adjudication.safe.json` | Independent retry review adjudication |
| `group4-all-admission-db-provider-closure.safe.json` | Exact 11-root closure |
| `controller-exact-native-close.safe.json` | Three exact terminal native executions |
| `sleep-recurrence-independent-review/` | Task-specific archive and composed-patch reviews |
| `main-integration-independent-audit/audit.safe.json` | Prospective integration scope only |
| `publish-handoff/` | Latest native observations and controller parking |

Private paths are pointers for an agent with this workspace, not Git artifacts.
Native tool session handles belong to their original agent; old agents are no
longer live. Inspect native state before assuming a managed handle remains usable.

## Next steps in order

1. Reconcile old native ownership and pending local cleanup receipts. Preserve
   captures and verify exact process birth before any signals; observation
   timeout is not termination. Keep the existing controller parked when unused.
2. Integrate current `main` before deployment. At the last checked base
   `b1e8a47e38fe1c0fdc872f8297a8efc9d4896b14`, conflicts were limited to generated
   `docs/rca/INDEX.md` and `scripts/cloudbench-prestack-source-reviews.json`.
   Reindex the actual archive and preserve all review records. Shared fingerprint
   records were identical; union was 28 records. Recheck newer main.
3. Certify the actual composed executable recipe and qualify changed scopes.
   The independent prospective audit preserved explicit task caps and retry/
   barrier/E2E behavior; 34/36 native inputs were identical. Its prospective
   fingerprint `c58a595fc9841edbe0884f5e8c80a234dcaa33e894c45c12cbcb4427cae321fe`
   is **not** actual merged-source certification. Incoming phone, schema, UI,
   archive, fleet and lifecycle changes need appropriate normal checks.
4. Finish `/deploy` on one frozen final source: normal quick gates, bounded exact
   CodeRabbit review, full non-skipped smoke, AgentCard four-task gate, semantic/
   chat-20 gates, merge/rollout, production checks and exact release. Batch valid
   findings and retain the review ledger; do not spend cycles on intermediate
   documentation pushes. Recheck Mac Temporal connectivity before paid runs.
   The documented smoke cloud alternate is
   `bash scripts/run-deploy-stage smoke -- bash scripts/run-predeploy-cloud`.
   AgentCard requires its prescribed local four-task lane; a prepared Linux
   controller can host it. An arbitrary cloud payment fleet is not that gate.
5. After final-source deployment and paid-gate quiescence, run the fresh simple
   CLI control. A prepared checkout exists at
   `/Users/andyprevalsky/Developer/rose-daily50-retry-control13-20261008`.
   It has started **no image clock, build or paid run**. Revalidate the current
   source, catalog, selection and setup; its prepared seed is
   `1453552795438288002`. New main may change the eligible pool.
6. Monitor printed exact handles continually, diagnose actual failures in
   parallel, update charts from measured producer clocks, and repeat until all
   five 50-wide runs qualify in a row. Retain genuine task failures honestly.

## Reporting and dashboard work still requested

Restore and open the dashboard from its existing owner/config at
`http://127.0.0.1:50629/?view=graphs`; its recorded server/writer were absent at
handoff. The chart code/data lives under the root workspace's
`.context/acceptance/startup-speed-20261005/dashboard/` and
`.context/fresh-claude-grouped50-20261006/`. Preserve measured history.

User requested **iteration as the first report column**, elapsed total for that
iteration from its original image start, and per-benchmark INFRA count/rate.
Add a clear per-iteration chart of those values, with visible axes and auto
refresh. Count actual distinct logical tasks with INFRA failures, distinguish
recovered attempts from final unresolved failures, and do not turn one original
failure into 50 merely because the whole slice is rejected. Unknown data stays
unknown. The earlier rejected control 11 recorded 31 PASS/18 genuine FAIL/
1 INFRA, so its benchmark INFRA rate was 1/50 (2%), not 50/50.

Concise progress tables must also show PST twelve-hour timestamps, time since
the last log, exclusive occupancy stages, the deploy checkpoint and version.
Show real stage durations, evidence publication, full release and total E2E.
Keep charts concise; show an approval blocker only when the actual deployment
gate needs user approval. Finish the requested dashboard update and open it.
