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
    "env": {
      "CONDUCTOR_WORKSPACE_NAME": "deploy-backend",
      "CONDUCTOR_PORT": "12000"
    },
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
Independent worker roots launch concurrently, including while an unrelated
failure awaits RCA. There is no host-wide admission queue or capacity-driven
serial fallback. An active operation on the same isolation root is refused
before launch; its existing owner and deadline remain authoritative. A concrete
capacity shortfall must be reported, not converted into hidden suite ordering.

At quiescent TRIAGE, run missing independent full gates without disposing of the
original failures:

```bash
python3 scripts/deploy_test_cycle.py triage-independent --plan "$PLAN" \
  --state-dir "$STATE" --root "$SOURCE" --exclude-root /currently/leased/worker
```

For changed source, the existing `refresh --input <old-plan>` also accepts
quiescent TRIAGE: original pending occurrences, source identities and cleanup
obligations stay recorded. New-source quick checks return to TRIAGE, where this
action can observe independent full gates. Source/contract/input equivalence is
still required to carry a full PASS; absent declared input scopes remain `*`, so
actual source edits conservatively invalidate reuse rather than relabel old runs.
An old-source nonblocking diagnosis remains historical: it cannot create a
new-source skip. The existing current-source renewal occurrence must be
adjudicated explicitly; source-bound resource qualifications require current
execution. Final full verification on the new source remains mandatory.

Repeat `--exclude-root` for actual leased roots. Gates with pending failures,
valid complete full receipts, or excluded roots are left untouched. Selected
gates keep the full original commands, checks and deadlines and launch together.
The action appends genuine native attempts and any new failures, preserves all
original pending failures and obligations, and returns to TRIAGE with ready=false.
It cannot authorize merge or replace the final exact-source coverage verifier.
The documented focused-then-full rerun sequence still applies to actual failed
tests. Historical repair labels do not rerun an unchanged, already verified full
PASS; changed inputs, a newer failure, or unknown cleanup invalidate reuse as
before. Healthy and unrun independent gates need not wait for that repair.

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

Before a cloud launch, a genuine local Claude credential SKIP can be admitted
through `deploy_test_cycle.py standing-skip --proof <proof.json>` with the
normal `--plan`, `--state-dir`, and `--root` arguments. This uses the existing
`validate_predeploy_receipts.py` contract: exact frozen source, one native
`claude-code-agent` run and report card, native benchmark/stack cleanup,
confirmation and plan/run bindings, and hashes of every consumed file.
The proof records `source`, `gate`, `summary`, `run_dir`, `confirmations`,
`bindings`, and the `files` hash map. Generic authentication errors, missing
artifacts, or an incomplete run do not qualify. The coordinator records a
separate warning and excludes only that case; it revalidates the evidence
before execution and final verification. The original cloud outcomes stay
unchanged, and ordinary cloud/fleet credential enforcement stays strict.

`scripts/deploy_test_worker.py` is the supplied case-aware executor for an
already prepared isolated checkout. Use it directly with request/result paths,
or `--stdio` over the existing worker transport. For example, a worker binding
can set `command` to an SSH argv ending in `python3 scripts/deploy_test_worker.py
--stdio`, `result_transport` to `stdout`, and `recipe` to:

```json
{
  "cases": {
    "coordinator": {
      "command": ["python3", "scripts/tests/deploy-test-cycle.test.py"]
    },
    "selection": {
      "command": ["python3", "scripts/tests/deploy-test-plan.test.py"]
    },
    "worker": {
      "command": ["python3", "scripts/tests/deploy-test-worker.test.py"]
    }
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
The public boxes.dev APIs currently expose agent-authored final text and
unattested attachments, so this transport cannot grant execution credit even
when those candidate bytes match. It retains the attempted owner and records
`native-evidence-unavailable`. Use the existing `local-isolated` native process
transport until an independently authenticated native reader is available.

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
  "source": {
    "head": "exact requested head",
    "digest": "exact requested digest"
  },
  "gate": "backend-coverage-blackbox",
  "complete": true,
  "cleanup_complete": true,
  "cases": { "selected-case-id": "PASS", "another-case-id": "FAIL" }
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
The one exception is the value of a `GITHUB_TOKEN` line in those env files: the devbox
daemon rewrites that short-lived credential several times an hour, so the digest keeps the
key and every other byte but not its value. Any other config change still stales the cycle.

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
The staged runner retains a full PASS only when its original request, receipt,
worker result, complete gate contract, environment and input fingerprint still
match. It records the new validation source separately and rechecks those
artifacts before merge. An identical full run already completed in a repair
phase can also satisfy final coverage; a narrowed focused run cannot.

A gate without declared `input_paths` conservatively depends on all source
files. Such a gate can carry through a history-only or tree-identical sync,
but an ordinary source change still requires a rerun. Legacy receipts missing
the execution bindings also rerun. Never invent a narrow scope to obtain reuse.
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

## Changed-source AgentCard warning renewal

`refresh` still revokes resource warnings whose inputs changed. For an already
confirmed **sandbox AgentCard release stall**, the two typed actions below can
qualify only that original case for exclusion from the new full sweep. They do
not create a native result, financial cleanup credit, refund, or passing test.
The original complete FAIL/native SKIPPED row, snapshot, confirmation and warning
history remain intact. Compute quota and other exceptions cannot use this path.

After the source is frozen, retain the previous plan, generate the new plan with
`deploy_test_plan.py` and the same worker bindings, and use the ordinary refresh:

```bash
python3 scripts/deploy_test_cycle.py refresh --input .context/deploy-pipeline/previous-plan.json --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline
python3 scripts/deploy_test_cycle.py prepare-agentcard-renewal --occurrence ORIGINAL_WARNING_ID --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline > .context/deploy-pipeline/agentcard-renewal-binding.json
./node_modules/.bin/tsx back-end/scripts/agentcard-confirm-stall.ts .context/deploy-pipeline/agentcard-renewal-binding.json .context/deploy-pipeline/agentcard-renewal-proof.json
python3 scripts/deploy_test_cycle.py renew-agentcard-warning --proof .context/deploy-pipeline/agentcard-renewal-proof.json --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline
python3 scripts/deploy_test_cycle.py run --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline
```

Run the producer with the existing managed organization authentication; it does
not load or edit env files. Keep both JSON files private. The proof output must
not already exist. No provider calls occur in the Python actions. The producer
uses only `get_card(card_id)` and `list_transfers(status=consumed, limit=100)`,
sharing one organization retry deadline. It retains only allowlisted metadata.
Missing, ambiguous, live, changed, or no-longer-stalled resources fail closed.
Never request card details or retry minting/reclaiming to obtain a proof.

The proof schema is `{binding, started_at, finished_at, observations}`. Binding
contains `kind: agentcard-release-stall-renewal-v1`, occurrence, original warning
and native-file SHA256, original/current source, plan/input/environment digests,
unchanged task/payment/assertion contract digest, producer SHA256, original
resource IDs, amount and `prepared_at`. Observation contains only card
`id/status/balanceCents` (plus `livemode: false` only when the vendor supplies
that field) and transfer
`id/cardId/status/amountCents/transferredCents/releasedCents/livemode`. It must
show the original CLOSED zero-balance card and its exact linked consumed transfer
with `livemode: false`, the original transferred amount and zero released. An
absent card mode stays absent; an explicit live or malformed card mode is
rejected. Sandbox mode must always be proved by the linked transfer. Preparation precedes both
fresh read timestamps; admission requires a read started within five minutes.
An exact accepted proof is idempotent. All remaining current-source checks run
under the existing full-plan, source, cleanup and deadline rules.

The provider's transfer listing is a bounded newest-first window. If exactly
100 distinct, dated rows are all newer than the original native failure's
completion and omit its transfer, the producer can instead record
`observations.transfer_page` with count, oldest timestamp and a redacted row
hash. The original exact card must still be CLOSED with zero balance. This
preserves the historical no-retry obligation, not a current transfer-state
claim: the financial state stays UNVERIFIED and the original obligation stays
open. Original-native, unchanged-contract, producer, current-input and freshness
guards remain mandatory; every peer executes. Partial, old, duplicate, malformed
or mixed pages fail closed. No refund, release or PASS is inferred from absence.

## Historical AgentCard no-retry custody

When payment implementation changes invalidate warning renewal, a confirmed
historical sandbox stall still must not be reissued. This is a separate typed
`NO_RETRY_CUSTODY` omission, not a renewed provider warning. It preserves the
original native FAIL/SKIPPED, source, financial snapshot and pending auth repair
packet. Current execution and financial state remain **UNVERIFIED**; omitted
cases have `case_complete=false` and receive no execution or financial credit.
Every other selected current-source check runs normally.

After the parent freezes the new source and writes the ordinary new plan, run:

```sh
python3 scripts/deploy_test_cycle.py prepare-historical-no-retry --input .context/deploy-pipeline/previous-plan.json --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline > .context/deploy-pipeline/historical-no-retry.json
python3 scripts/deploy_test_cycle.py refresh --input .context/deploy-pipeline/previous-plan.json --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline --historical-no-retry-proof .context/deploy-pipeline/historical-no-retry.json
python3 scripts/deploy_test_cycle.py run --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline
```

Preparation reads existing evidence only: exact native bytes, task catalog,
sealed fleet audits and absent owner registries. It does not read the provider,
retimestamp old observations, assert unchanged payment code, or resolve a repair.
A changed task, corrupt evidence, live/unknown owner, missing projection or mixed
waiver refuses refresh/admission/verification. Repeated source changes require
another exact binding. Pending post-merge debt survives until the existing
`resolve` action records the actual repair link. Legacy warning renewal and
compute-quota revocation keep their existing requirements.

### Import custody into an independent repair cycle

The refresh commands above operate on one existing cycle. An independent repair
uses the ordinary current full plan and normal `init`, then the separate typed
import below. The donor cycle is an immutable evidence index, never the current
state. No donor attempt, PASS, READY, environment, fingerprint or legacy skip is
imported. Original failures, native statuses, authority, pending auth repair or
its actual repair link stay intact. Both current execution and financial state
remain UNVERIFIED, with no credit; every peer still executes.

First review and admit the exact immutable native/adapter files and complete
fleet lifecycle/local/canonical audit trees required by `known()` and
`historical()`. Include discovery dependencies even when they are not protected
cases. Admission must check approved manifests, canonical paths and hashes,
refuse symlinks/differing overlaps and create files without overwriting. This
metadata API copies no files and cannot bypass missing closure, active owners,
broken ownership symlinks, live PIDs, changed catalogs or native financial joins.
Never overlay source, managed configuration, requests, live claims or a donor
`cycle.json`. Obtain the approved donor-index hash from the verified preservation
manifest; do not compute a replacement hash to authorize changed donor bytes.

Keep the current cycle separate from historical `attempts/<round>` paths.
Use the existing `DEPLOY_TEST_CYCLE_STATE_DIR` (or `gates --state-dir`) route;
`DEPLOY_RUN_ROOT` selects timing receipts. There is no `ROSE_DEPLOY_RUN_ROOT`
setting. Set these before plan generation/init and retain them throughout.
Existing request-owned/canonical custody locator checks are unchanged. A custom
cycle requires the default `.context/deploy-pipeline/cycle.json` to be absent.

With the parent-frozen source and the normal template and provisioned inventory,
the parent generates the full plan through `deploy_test_plan.py --inventory`
and initializes it before any gate execution. `scripts/deploy gates --dry-run`
shows the normal selection/worker commands; it is not a prepare-only execution
mode. The following commands consume those already prepared paths:

```sh
python3 scripts/deploy_test_plan.py --inventory "$INVENTORY" --template "$TEMPLATE" --base origin/main --output "$PLAN"
python3 scripts/deploy_test_cycle.py init --plan "$PLAN" --state-dir "$DEPLOY_TEST_CYCLE_STATE_DIR"
python3 scripts/deploy_test_cycle.py prepare-historical-import --input "$DONOR" --donor-sha256 "$DONOR_SHA256" --plan "$PLAN" --state-dir "$DEPLOY_TEST_CYCLE_STATE_DIR" > "$IMPORT_PROOF"
python3 scripts/deploy_test_cycle.py admit-historical-import --input "$DONOR" --donor-sha256 "$DONOR_SHA256" --proof "$IMPORT_PROOF" --plan "$PLAN" --state-dir "$DEPLOY_TEST_CYCLE_STATE_DIR"
```

`DONOR` is the absolute canonical path to the preserved donor `cycle.json`.
`IMPORT_PROOF` is a new private output file. Preparation leaves the current
cycle unchanged. Admission re-reads donor/native evidence and binds the exact
target cycle path plus fresh current source/full-plan/environment/input hashes.
It requires pristine initialized state and no existing attempt namespace. All
validation precedes the cycle writer's atomic publication. Immediate exact
replay is idempotent; drift or non-fresh current state refuses admission without
changing it. `--historical-no-retry-proof` is accepted by same-cycle `refresh` and the
donor-plan `import-historical-no-retry` flow below; supplying it to `init` fails
instead of silently losing custody.

After reviewing the admitted state, the parent runs the existing Python CLI
entrypoint in the same pinned environment used for manual init/import:

```sh
python3 scripts/deploy_cli.py gates --state-dir "$DEPLOY_TEST_CYCLE_STATE_DIR"
```

Keep the same plan inputs, worker bindings and timing root. The `scripts/deploy`
shell wrapper prepends dependency directories to `PATH`; invoking it after a
manual Python init changes the bound environment and correctly refuses execution.
The Python CLI entrypoint preserves that caller environment and uses the ordinary
gate coordinator. No import command starts workers, contacts a
provider, renews a provider warning, retries a payment, or clears repair debt.
Production live-mode duties remain with their separate owner and are not
eligible for this sandbox protocol.

### Independent-deploy custody transfer

A donor deploy's full ledger is not the new repair's execution ledger. Its
selection may include checks that the independent repair's current planner
does not select. Same-deploy `refresh` still refuses to remove originally
selected checks; do not edit that guard or overlay a donor READY cycle.

After restoring and hash-validating the immutable donor evidence/audits, retain
its cycle and plan separately. Prepare against the new frozen full plan using
the donor state directory, then initialize the new cycle normally and import
only its verified no-retry facts:

```sh
python3 scripts/deploy_test_cycle.py prepare-historical-no-retry --input <donor-plan.json> --plan .context/deploy-pipeline/plan.json --state-dir <donor-state-directory> > .context/deploy-pipeline/historical-no-retry.json
python3 scripts/deploy_test_cycle.py init --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline
python3 scripts/deploy_test_cycle.py import-historical-no-retry --input <donor-plan.json> --donor-state <donor-state-directory>/cycle.json --historical-no-retry-proof .context/deploy-pipeline/historical-no-retry.json --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline
python3 scripts/deploy_test_cycle.py run --plan .context/deploy-pipeline/plan.json --state-dir .context/deploy-pipeline
```

Import requires an exact fresh current-source ledger and revalidates the donor
plan/state, native bytes, catalog contracts, sealed audits and absent owners.
It transfers the immutable failure history and canonical pending/resolved
repair debt, with a donor digest and current binding. No donor PASS, READY,
attempt, provider waiver or execution qualification is imported. Every selected
current peer executes; protected cases remain `NO_RETRY_CUSTODY`, without
execution or financial credit. Exact replay is idempotent and revalidates the
current binding and complete transferred obligations. Removing any protected
failure/history/projection fails closed during ordinary guard/admission/verify
as well as replay. Duplicate identities and changed debt wrappers are rejected
before atomic publication. No provider timestamps are refreshed.
