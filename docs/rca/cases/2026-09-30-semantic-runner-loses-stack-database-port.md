---
id: 2026-09-30-semantic-runner-loses-stack-database-port
date: 2026-09-30
title: Fresh semantic runner seeded a different Postgres database than the active stack
surface: harness
component: front-end/scripts/run-semantic-tests.sh
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/scripts/run-semantic-tests.sh::apply_local_semantic_db_urls discarded stack database identity across test shells; the October recurrence preserved runtime port but omitted manifest database name
symptoms:
  - 'The column BrowserSession.kernelProxySource does not exist in the current database.'
  - 'PrismaClientKnownRequestError P2022 in seed-browser-take-control-e2e.ts'
  - 'Hand back control absent after Take control'
  - '404 Session not found from POST /api/browser-session/task/:taskId/control'
  - 'semantic runner must preserve the active stack database name'
tags:
  - semantic
  - take-control
  - local-db-port
  - deploy
  - postgres
  - database-name
sources:
  - PR #1344
  - PR #1512
  - commit edd03da7268b72d32fa345b503e88ef5645c110b
  - agent 35693a7b-5fbf-45e6-a907-4dc378f63a34
repro: scripts/tests/semantic-deploy-gate.test.sh
status: mitigated
---

## Problem

The local `/deploy` stack served its backend on port 55170 and its Postgres on
55175. A separate semantic command launched in a fresh shell with
`BACKEND_PORT=55170` but no `LOCAL_DB_PORT`. Seven UI specs passed; the
`browser-take-control` setup failed before opening the UI. Prisma reported
`P2022` because `BrowserSession.kernelProxySource` was absent from the database
that the seed script reached. The active stack database did contain that column.

The failing run is `.context/deploy-runs/20260930-235404-20524/logs/semantic-20261001-005520-84777.log`.

## Diagnosis

Critical path: `run.sh` writes the stack's actual backend and database ports to
`.context/services.json` → `/deploy` invokes the semantic runner in a new shell
→ `apply_local_semantic_db_urls` has no inherited `LOCAL_DB_PORT` and exports no
URL → the take-control spec defaults to localhost:5432 → its seed writes to a
different database than the backend uses. The active `victoria` database at
55175 had the new column; the database reached by the test did not. The first
bad boundary is the runner dropping the stack's database identity when it
crosses into a fresh process.

Archive searches: `BrowserSession.kernelProxySource does not exist semantic
take-control P2022` and `fresh semantic shell missing LOCAL_DB_PORT seeds wrong
Postgres database`. The closest case,
`2026-09-09-deploy-local-db-port-ignores-system-postgres`, fixed the wrong port
advertised *inside* the stack environment for system Postgres. This incident
is a relative: the port was correct in the stack, but unavailable to the
separate semantic shell. Its existing `LOCAL_DB_PORT` test did not exercise a
missing variable with a live stack manifest.

## Solution

When `LOCAL_DB_PORT` is absent, the semantic runner reads the database runtime
port from `run.sh`'s running service manifest, but only if that manifest's backend
URL matches the backend under test. An explicit caller database URL or port takes
precedence. A missing, stopped, mismatched, or malformed manifest now fails
before Playwright instead of silently choosing localhost:5432. This uses the
stack's actual Docker or system Postgres choice instead of deriving a Docker
port from `BACKEND_PORT`.

The permanent deploy structural regression extracts the real runner function
and checks matching, mismatched, system Postgres, stopped and malformed manifest
cases, plus explicit caller overrides. With the old runner
at `.context/semantic-runner-under-test.sh`, this exact command exited 1 with
`FAIL: semantic runner must read the active stack database port`:

```sh
SEMANTIC_RUNNER_OVERRIDE="$PWD/.context/semantic-runner-under-test.sh" bash scripts/tests/semantic-deploy-gate.test.sh
```

After replacing that file with the fixed runner, the identical command exited
0 with `All semantic deploy gate checks passed`. The focused unchanged
`browser-take-control` Playwright spec passed (1/1, 18.4s), then the complete
local semantic gate passed eight UI specs and five latency checks. The structural
suite is run by `/deploy` Step 4s on every deploy.

No production route changes. The extra manifest lookup occurs once per local
semantic invocation.

## Human feedback

None recorded.

## Reusable lesson

Carry the active stack's database identity across fresh test shells through its manifest, and fail closed when the identity cannot be proven.

## Recurrence — 2026-10-14: isolated database name was discarded

### Problem

During local `/deploy` for PR #1512 at immutable commit
`edd03da7268b72d32fa345b503e88ef5645c110b`, the unchanged take/hand-back semantic
failed at `browser-take-control.spec.ts:160`: `Hand back control` was absent
within its existing 5000ms assertion. Agent `35693a7b-5fbf-45e6-a907-4dc378f63a34`
and synthetic task `d0bbc99f-08a3-46af-bc97-8b864133df09` identify this additional
deploy-fixture incident, separate from the original production payment incident.

The preserved stack manifest named database
`victoria_bench_deploy_payment_fill_semantic_20261014_1843` at localhost:5432.
The seed instead wrote task `d0bbc99f-08a3-46af-bc97-8b864133df09` into `victoria`.
GET control started at 18:46:58.365Z and completed with 404 at
18:46:58.375Z. The two Take control POSTs started at 18:47:04.243Z and
18:47:04.281Z, then completed with `404 Session not found` at 18:47:04.249Z
and 18:47:04.285Z, respectively (6ms and 4ms). Original trace, screenshot, error context and backend logs remain
under `.context/deploy-payment-fill/.context/semantic-failure-1/`.

### Diagnosis

Critical path: `run.sh` records database name/runtime port → semantic launcher
passes only `LOCAL_DB_PORT=5432` → `apply_local_semantic_db_urls` bypasses its
manifest read and constructs `/victoria` → DB seed creates the synthetic session
in the wrong DB → production control route queries the isolated backend DB →
404 prevents user ownership and the Hand back button.

This is a recurrence of the incomplete September database-identity guard.
That fix retained runtime port, but did not retain database name; its fixtures
asserted ports and omitted `database.name`. Even the manifest-read path still
hardcoded `victoria`. The first bad boundary is the runner constructing the
wrong seed URL, before any browser control or chat completion behavior.

Concurrent real chat completed at 18:46:56.378Z. It is explicitly excluded as
the causal explanation: the exact synthetic wrong-DB row was subsequently read
as ACTIVE/AGENT, and the control lookup does not filter terminal agent/session
status. Restoring the correct DB identity made the unchanged UI flow pass
without modifying chat, prompts, routes, timeouts or terminal semantics.

Executed owning-boundary proof uses the unchanged proposed DB-identity block
extracted from the existing `scripts/tests/semantic-deploy-gate.test.sh`:

```sh
SEMANTIC_RUNNER_OVERRIDE=/home/boxes/rose/.context/deploy-payment-fill/front-end/scripts/run-semantic-tests.sh bash .context/semantic-control-diagnosis/owning-db-identity-subset.sh
# exit 1: FAIL: semantic runner must preserve the active stack database name
SEMANTIC_RUNNER_OVERRIDE=/home/boxes/rose/.context/semantic-control-diagnosis/run-semantic-tests.sh bash .context/semantic-control-diagnosis/owning-db-identity-subset.sh
# exit 0: PASS: all existing-suite DB identity behaviors
```

The complete proposed existing semantic deploy gate also passed exit 0:

```sh
SEMANTIC_RUNNER_OVERRIDE=/home/boxes/rose/.context/semantic-control-diagnosis/run-semantic-tests.sh bash .context/semantic-control-diagnosis/semantic-deploy-gate.test.sh
# All semantic deploy gate checks passed.
```

Archive searches were `Hand back control Browser session not found control 404`,
`synthetic browser semantic seed chat completion status chip`, and `semantic
runner loses stack database identity manifest seed wrong database`; results are
retained privately. The third found this case. The September system-PG port
case and July hardcoded restore-name case are relatives at different boundaries.
Live GitHub main at `01886ebb50a6d1ca377a6416321d656febb7a27d` still contains the
same buggy helper; its source was captured privately. A complete changed-file audit of all 236 then-open PRs found only #1180
touching the semantic runner; its diff changes production frontend health
probing, and its older head has no DB-identity helper. No owning-helper fix was
found among those open PRs. This statement is scoped to the audited source
paths; alternate launcher changes were not established as a general fix.

### Solution

Operational mitigation used existing explicit `SEMANTIC_DATABASE_URL` and
`SEMANTIC_DIRECT_URL` inputs with the exact isolated DB identity. The unchanged
full UI batch passed 8/8 in 33.9s, including take/hand-back in 14.4s, in
`.context/deploy-payment-fill/.context/group4-semantic-retry.log`. These are
UI outcome proof for corrected configuration; they do not mean the pending
permanent runner change has shipped, nor prove the unrelated original payment
flow. Group 4 latency and smoke remained separate parent-owned gates.
The scrubbed invocation receipt at
`.context/deploy-payment-fill/.context/semantic-failure-1/correct-db-invocation-receipt.json`
records immutable source HEAD, the active database
`victoria_bench_deploy_payment_fill_semantic_20261014_1851` at port 5432, and
matching explicit DATABASE/DIRECT URLs observed in the live latency process
inherited from the same parent shell after the UI invocation. Its provenance
links to the original full parent shell invocation; it is not a direct snapshot
of the already-completed UI process environment.

The permanent runner repair resolves manifest database name and runtime port
together whenever a manifest exists, including when LOCAL_DB_PORT is supplied;
it rejects stopped/mismatched/malformed manifest metadata and conflicting caller ports.
Explicit DATABASE/DIRECT URL precedence remains. Extend the existing owning
semantic deploy gate with named Docker/system-PG fixtures, caller-port cases,
stopped/mismatched/malformed metadata rejection and independent explicit URL precedence.
That suite is already registered in `scripts/run-deploy-structural-gates.py`
and `/deploy` Step 4. No new suite or product prompt/schema changes are needed.
The helper checks manifest metadata only; it does not validate PID liveness
for a running manifest reusing the same backend URL. Independent adversarial
review passed with these wording/fixture corrections. The repair is included in this deployment stabilization batch. Default-runner
UI verification and production rollout remain gates before shipment; this
recurrence is mitigated pending those results.

The wrong-DB row was snapshotted before cleanup. Parent deleted only the exact
session using task, agent, context, provider session, debug URL and ACTIVE/AGENT
predicates; receipt records DELETE 1, and parent independently verified count=0
in localhost:5432/victoria. BrowserContext/profile/cookies were preserved.
Receipt: `.context/deploy-payment-fill/.context/semantic-failure-1/synthetic-row-cleanup.log`.
Snapshot and guarded SQL remain under `.context/semantic-control-diagnosis/`.

### Human feedback

None recorded for this recurrence. The task requires preserving the existing
semantic assertions/timeouts, original payment proof and protected instructions.

### Reusable lesson

Carry the complete database identity across test-shell boundaries, including
both manifest name and runtime port, and reject unproven target identity.
