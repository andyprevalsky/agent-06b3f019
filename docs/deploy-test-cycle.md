# Staged, change-selected deploy validation

This is the execution contract requested for `/deploy`: quick checks in parallel,
then all selected independent categories in parallel. No affected category is
silently removed to meet a time budget. Production checks still wait for the
actual deployment. This changes local validation/retry order, not production
approvals, ownership, or failure attribution.

## Selection and workers

`python3 scripts/deploy_test_plan.py --workers workers.json --base origin/main
--output .context/deploy-cycle/plan.json` uses the existing
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
explicit stable `checks` IDs. Quick categories are `format`, `eslint`,
`typescript`, and application `backend-structural` / `application-structural`.
The coordinator launches all quick checks together and gives each at most120s.
Formatter **checks** run here; automatic formatting precedes the source freeze.
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
    "command": ["path/to/provisioned-worker-adapter", "backend"]
  }
}
```

These are explicit, provisioned executors, not permissions to allocate machines
or run every heavy test on the coordinator. Each adapter owns its isolated
checkout, database, ports and teardown. It must validate the requested source
before executing and return results. The orchestrator launches every selected
worker concurrently; it does not add dependencies between coverage, semantics,
smoke, AgentCard, live probes or E2B. Existing worker safety and cleanup remain.
Do not pretend an executor label provides isolation: inspect the worker setup.

The cloud smoke adapter uses the benchmark CLI, keeps its existing task selection
and raw run receipts, and returns all selected outcomes. If no appropriate worker
is bound, planning refuses; it does not quietly serialize the suite locally.

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
5. For actual fixes, refresh to the new frozen source/plan, then run the quick
   checks again. Use `focus --input focused.json` to name the original failing
   checks plus relevant regressions and their real focused argv. Every blocking
   gate must be covered; a different green test cannot replace the failed one.
6. `run` the focused commands concurrently. Any failure returns to `/RCA`.
   When they pass, `run` the complete failed gates concurrently, including every
   originally selected case in those gates. Then repeat quick checks and `run`
   **all originally selected gates once** on the final frozen source.
7. `verify` (or the existing `run_deploy_pipeline.py verify` pointed at this cycle
   directory) exits0 only for a ready cycle with exact current source and plan.
   A failure in the final sweep returns to `/RCA`; changing code invalidates
   its evidence. Retain production source checks, review and approvals.

Source binding uses the existing pipeline's output-ledger exclusion for
`agents/benchmarks/history/`, so benchmark result append operations do not
masquerade as runtime edits. All other tracked/untracked source, ignored runtime
configuration and the worker commands remain bound and are rechecked.

A focused JSON has `source` and a `gates` mapping, each value with argv `command`
and `checks`. Never relax a test's assertions/timeouts to fit this cycle. Preserve
failure histories across source changes, skipped outcomes in the final report,
and delegated/external alerts from the canonical failure-report renderer.

This implementation depends on the shared failure-policy helper being delivered
by the triage-owner change (PR1580); do not fork that policy. Missing helper or
invalid receipts fail closed. RCA submissions use the occurrence ID as their
idempotency key; ambiguous submission is preserved and must be reconciled with
the service, not sent again. A source refresh must re-establish exception
applicability to the new source; that is a metadata/evidence decision, not an
automatic rerun of an already qualified skipped case.

The coordinator handles TERM/INT by stopping only the process groups it started
and recording `interrupted`, never PASS or a provider waiver. Use `resume` only
after the worker's teardown is verified. A worker that leaves descendants behind
produces an unverified result; it is not safe to begin another stack over it.
`report` renders the canonical delegated/provider warnings with the original
failure records. It does not turn a skipped test into a successful observation.
