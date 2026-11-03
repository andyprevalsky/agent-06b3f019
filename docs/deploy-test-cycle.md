# Staged, change-selected deploy validation

This is the execution contract requested for `/deploy`: quick checks in parallel,
then all selected independent categories in parallel. No affected category is
silently removed to meet a time budget. Production checks still wait for the
actual deployment. This changes local validation/retry order, not production
approvals, ownership, or failure attribution.

## Selection and workers

`python3 scripts/deploy_test_plan.py --workers workers.json --base origin/main
--output .context/deploy-pipeline/plan.json` uses the existing
change-to-test graph. It includes complete categories reached by the diff and
its consumers, plus broad integration triggers. An unknown path selects all;
an unknown category is included. The output records every inclusion and omission.
A backend API change can select frontend tests without a frontend file edit.
The selected set is fixed for the cycle and may only grow during repairs.

Default recipes come from the existing pipeline's full commands, plus format,
controller, seed-memory and Mac coverage checks. `--template recipes.json` can
supply case-aware adapters instead. Platform-unavailable Mac checks are recorded
as unverified omissions under the standing Linux exception, never passed.

Recipes contain a `gates` array, with `name`, `category`, argv `command`, and
explicit stable `checks` IDs. Every plan must include `format`, `eslint`,
`typescript`, and application `backend-structural` / `application-structural`
as mandatory quick categories.
The coordinator launches all quick checks together and gives each at most120s.
Formatter **checks** retain the existing TypeScript/TSX scope; automatic
formatting precedes the source freeze.
Deploy-tooling regressions are an affected category, never a quick check.

Every selected nonquick gate needs a worker binding:

```json
{
  "smoke": {
    "id": "cloud-smoke-worker",
    "transport": "benchmark-cloud-cli",
    "command": ["bash", "scripts/run-predeploy-cloud"]
  },
  "backend-coverage-blackbox": {
    "id": "independent-backend-worker",
    "transport": "local-isolated",
    "cwd": "/prepared-workers/backend",
    "worker_root": "/prepared-workers/backend",
    "env": {"CONDUCTOR_WORKSPACE_NAME": "deploy-backend", "CONDUCTOR_PORT": "12000"},
    "timeout_seconds": 3600
  }
}
```

These are explicit, provisioned executors, not permissions to allocate machines
or run every heavy test on the coordinator. Each adapter owns its isolated
checkout, database, ports and teardown. It must validate the requested source
before executing and return results. The orchestrator launches every selected
worker concurrently; it does not add dependencies between coverage, semantics,
smoke, AgentCard, live probes or E2B. Existing worker safety and cleanup remain.
The planner rejects bindings inside the coordinator checkout, overlapping
worker roots, or shared workspace/database identities and ports. SSH bindings
name their actual host and prepared root; the returned receipt must match that
root. These checks do not provision a host or prove its capacity: the owner must
still prepare private caches/services and verify the worker setup.

The JSON above is an inventory for already provisioned workers. Use
`--inventory inventory.json` instead of `--workers workers.json` to generate
commands from those identity/transport/root/env/deadline fields.
`deploy_test_bindings.py` generates the actual
transport and the unchanged full-suite recipe from the versioned template.
The illustrative 3600-second transport deadline must be replaced with the
gate's existing deadline, not treated as a new test timeout. Listener port
footprints use the existing port allocator's offsets; base ports alone are
not sufficient proof that workers cannot collide.
Multi-case templates need their actual `recipe`; an aggregate nonzero exit is
UNVERIFIED rather than proof that every constituent ran. It cannot be waived.

For a new local worker checkout, after committing the exact source freeze run
`python3 scripts/deploy_test_worker.py --root "$SOURCE" --prepare-checkout
"$NEW_WORKER_ROOT"`. The command refuses dirty source or an existing checkout,
clones the exact commit, and verifies equal source digests. `--copy-config`
explicitly copies the private local configuration without displaying it;
prepare the pinned dependencies through `CLAUDE.md` before starting gates.
For an existing remote host, prepare that same commit and configuration there
through its existing owner, then use `transport: ssh`, `worker_host` and
`worker_root` in the inventory. The worker independently verifies the requested
source before executing. This path does not allocate machines or waive setup.

The standard cloud smoke adapter is `deploy_test_cloud.py`. Planning reads the
existing `run-predeploy-cloud --list` selector, then the adapter calls the
existing `run-bench` cloud CLI with the active task names, `--wait`, and the exact
frozen `--ref`. It does not repeat the old launcher's offline structural checks:
those belong to the selected deploy-tooling category. Native child receipts,
execution provenance and the fleet's teardown audit must agree. Task outcomes
stay separate: a native skip enters `/RCA` as a recorded failure until qualified;
an already qualified skip is omitted from later CLI argv. Missing children,
source mismatch, cancellation and cleanup gaps stay UNVERIFIED. The adapter
does not allocate outside the existing CLI or invent a cleanup receipt.
If no appropriate worker is bound, planning refuses; it does not quietly
serialize the suite locally.

`scripts/deploy_test_worker.py` is the supplied case-aware executor for an
already prepared isolated checkout. Use it directly with request/result paths,
or `--stdio` over the existing worker transport. For example, a worker binding
can set `command` to an SSH argv ending in `python3 scripts/deploy_test_worker.py
--stdio`, `result_transport` to `stdout`, and `recipe` to:

```json
{
  "cases": {
    "coordinator": {"command": ["python3", "scripts/tests/deploy-test-cycle.test.py"]},
    "selection": {"command": ["python3", "scripts/tests/deploy-test-plan.test.py"]},
    "worker": {"command": ["python3", "scripts/tests/deploy-test-worker.test.py"]}
  }
}
```

This example validates the three new modules; it does not replace the full
deploy-tooling category. The recipe's IDs must exactly match the full gate
inventory supplied by the template. `setup` and `cleanup` use the same command
shape; service-owning recipes require cleanup. Every active case runs even if
a peer fails. Source mismatch, setup failure, signal, timeout or cleanup failure
produces unverified evidence, not a completed test that can be waived. Each
result carries the recipe digest, command, native exit, timings and log hash.
Provisioning, authentication and native-resource teardown remain with the
existing worker owner; this adapter allocates nothing.
`transport: boxes-thread` binds a prepared, muted boxes.dev worker thread
(`worker_thread` = its clientThreadId, `worker_host` = that thread's
executionInstanceId from `dvb-onbox threads list --json`, absolute `worker_root`,
`python` inside it, `coordinator_thread` = the control thread that receives
attachments, and the gate deadline). `scripts/deploy_test_boxes.py` sends the
exact `deploy_test_worker.py` invocation once (`threads send`, idempotency key =
request token), persists its turn before and after the call so a restart adopts
the same turn, and accepts only the byte-exact native `DEPLOY_GATE_RESULT`
document whose sha256 the worker script itself declared: the attached
`result.json` first, inline marker bytes only as a hash-matching fallback. Prose,
summaries, a different devbox, token, root or recipe, CLI/permission errors,
oversize prompts or the deadline leave every case UNVERIFIED with the remote
cleanup owner recorded; this transport cannot express a waiver.

Streamed transports must also bind `timeout_seconds` to the existing gate's
outer deadline. Do not invent a shorter test budget or leave the transport
unbounded.
Worker stderr is preserved separately from its stdout JSON receipt. Request
input and receipt size are bounded; an incomplete transport cannot become PASS.

## Result protocol

The coordinator supplies `DEPLOY_GATE_REQUEST` (JSON file) and
`DEPLOY_GATE_RESULT` (output path). A case-aware adapter consumes the exact
`checks` and `skips` from that request, tests only the non-skipped cases, and writes:

```json
{
  "token": "copy the unique request token",
  "source": {"head": "exact requested head", "digest": "exact requested digest"},
  "gate": "backend-coverage-blackbox",
  "complete": true,
  "cleanup_complete": true,
  "cases": {"selected-case-id": "PASS", "another-case-id": "FAIL"}
}
```

It includes every requested case exactly once, no unrequested IDs, with exit0
iff all returned cases pass and exit1 for completed test failures. Signals,
missing/incomplete results, identity mismatches and launcher errors remain
unverified/blocking. Worker-authored `SKIP` is not accepted as a waiver. Plain
commands may use exit0 as a gate pass, but their nonzero result cannot be waived
without a complete case-aware result; an aggregate error is not proof the rest
of its tests ran. A mixed skip/run gate must use this protocol.

## Execution and repair

Before launching a selected gate or turning its first failure into repair work,
read `.claude/commands/deploy.md` → **Check permitted skips before launching or
diagnosing a gate**. The selected task's exception is part of its execution
instructions, not a fact to discover after repeated retries. Preserve the native
outcome and evidence; qualifying one symptom never waives unrelated assertions,
an incomplete result or cleanup.

1. `deploy_test_cycle.py init --plan ... --state-dir ...` binds the complete plan
   and source. Use an ignored `.context/` directory; evidence is not source.
2. `run` launches the quick checks concurrently, then the selected worker set.
   It advances until complete or an RCA/focused plan is needed. Clean first pass
   completes the cycle: do not run it twice.
3. Failures create individual JSON requests under `rca/` while healthy peers
   continue. Supply `run --rca-launcher <approved-launcher-argv>` to submit them
   immediately, or after the phase use `rca` with
   `--rca-launcher <approved-boxes-dev-launcher-argv>` to launch all independent
   `/RCA` assignments concurrently. The launcher receives each request path as
   its final argument and returns the service's delivery/creation receipt. It
   must follow the boxes.dev skills, inherit the actual parent configuration,
   and read existing evidence before grouping an occurrence into an existing
   root cause. No prompt fingerprints, acknowledgement waits or Rose activation.
4. Import the canonical RCA failure report with `triage --input report.json`.
   It uses `deploy_failure_report.decision`, not a second attribution policy.
   Each entry adds `check` (`gate/check`), the exact argv `command`, and `source` to the canonical
   fields. Every pending occurrence must be covered. `INTRODUCED` blocks;
   `UNKNOWN` blocks; a valid `NOT_INTRODUCED` handoff or evidenced provider
   exception becomes SKIP. Original native failures remain in the history.
   **If all failures are waived, advance without rerunning them.** An unexecuted
   check is not a waiver and cannot be hidden by a provider exception.
   For an incomplete execution whose underlying defect has a canonical
   NOT_INTRODUCED repair handoff, explicitly set `execute_unverified: true` in
   that occurrence's report to enter execution recovery. It records
   `execution required`, not SKIP: focused, full-failed and final runs remain
   required. This cannot authorize UNKNOWN causes or external-provider waivers.
5. For actual fixes, refresh to the new frozen source/plan, then run the quick
   checks again. Use `focus --input focused.json` to name the original failing
   checks plus relevant regressions and their real focused argv. Every blocking
   gate must be covered; a different green test cannot replace the failed one.
6. `run` the focused commands concurrently. Any failure returns to `/RCA`.
   When they pass, `run` the complete failed gates concurrently, including every
   originally selected case in those gates. Then repeat quick checks and `run`
   **all originally selected gates** on the final frozen source. For a sync-only
   change, a verified unchanged-input passing receipt may carry forward with
   its original source and equivalence proof; execute affected or unknown gates.
   Never turn a failed, incomplete or unverified result into a carried pass.
7. `verify` (or the existing `run_deploy_pipeline.py verify` pointed at this cycle
   directory with `--require-staged`) exits0 only for a ready cycle with exact current source and plan.
   A failure in the final sweep returns to `/RCA`; changing code invalidates
   its evidence. Retain production source checks, review and approvals.

Source binding uses the existing pipeline's output-ledger exclusion for
`agents/benchmarks/history/`, so benchmark result append operations do not
masquerade as runtime edits. All other tracked/untracked source, ignored runtime
configuration and the worker commands remain bound and are rechecked.

A focused JSON has `source` and a `gates` mapping, each value with argv `command`
and `checks`. With a case-aware worker, keep its transport `command` and add a
`worker_recipe` containing the focused test commands for exactly those checks.
That temporary recipe applies only to the focused phase; the following full
failed-gate and final phases execute the original bound recipe. Never relax a
test's assertions/timeouts to fit this cycle. Preserve
failure histories across source changes, skipped outcomes in the final report,
and delegated/external alerts from the canonical failure-report renderer.

This implementation depends on the shared failure-policy helper being delivered
by the triage-owner change (PR1580); do not fork that policy. Missing helper or
invalid receipts fail closed. RCA submissions use the occurrence ID as their
idempotency key; ambiguous submission is preserved and must be reconciled with
the service, not sent again. A source refresh must re-establish exception
applicability to the new source; that is a metadata/evidence decision, not an
automatic rerun of an already qualified skipped case.

### Sync while validation is active

Follow `.claude/commands/sync.md` at the boundary of the checkout and database
actually being changed. Healthy isolated workers may finish on their frozen
source. Retain those receipts and all original failures; never reset the cycle
to make the merged source look clean. Refresh only changed dependency inputs.

This staged runner does not inherit every reuse option of the legacy pipeline.
Use its supported `refresh` transition only when that transition's pending-work
and ownership checks pass. `triage-quick` can run the four fixed non-live quick
checks on a new source while unresolved triage remains bound to its original
source; it neither clears triage nor grants full-gate or release credit. Do not
describe a successful quick observation as a resumed or completed full cycle.
The final coverage and `verify` must still account for the actual merged source.
Do not invalidate all passing tests just because a conflict-free sync changed
HEAD: compare each gate's actual inputs, preserve valid receipts, and execute
only affected or unknown gates. A clean Git merge is not a test-dependency proof.
If pending execution ownership prevents another isolated lane from starting,
report that exact unsupported transition and continue supported independent work;
do not infer live execution from an owner label or infer cleanup from a dead PID.

The coordinator handles TERM/INT by stopping only the process groups it started
and recording `interrupted`, never PASS or a provider waiver. Use `resume` only
after the worker's teardown is verified. A worker that leaves descendants behind
produces an unverified result; it is not safe to begin another stack over it.
`report` renders the canonical delegated/provider warnings with the original
failure records. It does not turn a skipped test into a successful observation.

Use `.context/deploy-pipeline` for the cycle state, or set
`DEPLOY_TEST_CYCLE_STATE_DIR` and use that same directory throughout. Phase 3's
mandatory `verify --require-staged` refuses a missing staged cycle even when an
older legacy receipt says PASS. Exit5 means source/configuration changed;
exit1 means not ready, and exit2 means missing or malformed evidence. The staged
runner requests `/RCA` immediately for every failure, rather than waiting for
the legacy pipeline's repeated-round cap.
