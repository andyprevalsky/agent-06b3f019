# Deploy a verified worker process on existing Machines

This mode keeps the original Machine image, configuration and worker process
served while adding one authenticated runtime to each of eight explicitly owned
hosts. It performs no Machine create, clone, update, restart, stop or deletion.
The native image continues to identify the original runtime; per-process source,
boot, birth-time, health and native Temporal identities identify the new runtime.

Use this mode only from the exact qualified merged source and with the normal
`/deploy` test, review, backend/frontend, production semantic, workflow-edge and
AgentCard gates. The old stopped deployment ledger is preserved. Start a fresh
deployment lifecycle after development stabilization, never a fourth review in a
capped lifecycle. Keep an existing automatic Machine-rollout hold in effect; do
not re-enable a competing deployment to obtain a workflow success indication.

## Retained custody and resource qualification

Retain the exact eight existing IDs, original config/image fingerprints, previous
queue, merged source SHA, unique deployment attempt, independently checked Python
and installed-distribution digests, and actual Render service/database identity.
The distribution digest identifies installed metadata; it does not certify every
package file. Verify dependency compatibility through actual candidate startup
and the canonical native workflow fixture. Do not install into the old runtime.

The signed bootstrap verifies the complete archive and actual interpreter,
distributions, Machine version and boot before effects. It creates an exclusive
owned source/artifact slot and a new v1 memory leaf with a hard 1 GiB aggregate
limit and swap bound. Only the new child enters that leaf before UID drop. The
additional address-space limit is 1 GiB; admission reserves 256 MiB beyond that
maximum. The new child has OOM score 1000, checked again for healthy acceptance.
Unsupported controllers, missing readbacks, insufficient memory, or identity
uncertainty must block. No fallback to weaker limits is permitted.

Local mocked kernel tests do not qualify native enforcement. Retain native boot,
controller/readback, standby health, resource and original-worker observations
for all eight hosts. Observe coexistence while running the canonical candidate
fixture. The bound and launch reserve do not promise that an uncapped old process
can never experience global memory pressure. Do not alter old priorities or
processes to make qualification pass. If startup fails, preserve its intent,
logs and exact child identity; diagnose before another launch. Same-boot UNKNOWN
is not absence and does not authorize replacement.

## Operator sequence

Use the existing authoritative production credentials without printing them.
Set `PRODUCTION_WORKER_PROCESS_DEPLOYMENT=1` only for this bounded operator session.
Keep artifact, plan, cohort and validation files private (`0600`). The artifact
contains complete proprietary source. Never include it in console logs or public
benchmark evidence.

1. Confirm the exact merged backend source is functionally live. The backend
   recovery cron must run in the actual configured Render service against the
   plan's production database. Local/benchmark databases, another service, source
   drift, and CLI observations cannot publish its recovery certificate.
2. Build the immutable archive from committed Git bytes, not the working tree:

   ```bash
   python3 scripts/build-existing-worker-bundle.py \
     --repository "$DEPLOY_ROOT" --source-commit "$DEPLOY_MERGED_SHA" \
     --dependency-digest "$QUALIFIED_DISTRIBUTIONS_SHA256" \
     --python-digest "$QUALIFIED_PYTHON_SHA256" \
     --namespace "$TEMPORAL_NAMESPACE" --attempt "$AGENT_DEPLOYMENT_TOKEN" \
     > "$WORKER_PROCESS_ARTIFACT"
   chmod 600 "$WORKER_PROCESS_ARTIFACT"
   ```

3. From `back-end`, capture exact existing host custody once. Reuse the saved
   plan after interruption; do not recapture a changed baseline to hide drift:

   ```bash
   npx tsx scripts/deploy-existing-worker-processes.ts capture-plan --execute \
     --artifact "$WORKER_PROCESS_ARTIFACT" --hosts "$OWNED_EXISTING_WORKER_IDS" \
     --app "$AGENT_FLY_APP" --backend-service-id "$QUALIFIED_RENDER_SERVICE_ID" \
     --output "$WORKER_PROCESS_PLAN"
   npx tsx scripts/deploy-existing-worker-processes.ts stage --execute \
     --plan "$WORKER_PROCESS_PLAN"
   ```

   Registration durably saves the complete source and plan in `ToolSideEffect`.
   The backend and CLI use the existing global deployment lease. Only a positive
   locked MISSING status permits ensure. BOOTING, BLOCKED or UNKNOWN is not a
   successful stage. The supervisor may restart only its retained exited child.
   The backend recovers this exact desired state after backend/VM restart.

4. Obtain all eight fresh STANDBY receipts and exact validation workflow/activity
   pollers. Set `TEMPORAL_WORKER_BUILD_ID`, `TEMPORAL_WORKER_BUNDLE_SHA256`,
   `TEMPORAL_WORKER_DEPLOYMENT_TOKEN` and
   `TEMPORAL_CANDIDATE_VALIDATION_TASK_QUEUE` from this private artifact. Retain
   the normal production namespace and base queue. Execute the existing native
   candidate fixture, with its ordinary initialization, determinism, durable-state
   and cleanup assertions unchanged:

   ```bash
   npx tsx scripts/deploy-existing-worker-processes.ts verify-standby --execute \
     --plan "$WORKER_PROCESS_PLAN" > "$WORKER_PROCESS_COHORT"
   PRODUCTION_WORKFLOW_MIGRATION_VALIDATION=1 \
     npx tsx scripts/validate-candidate-workflow-image.ts --execute \
       --runtime-plan "$WORKER_PROCESS_PLAN" \
       --runtime-cohort "$WORKER_PROCESS_COHORT" \
       --runtime-receipt "$WORKER_PROCESS_VALIDATION"
   ```

   The fixture additionally binds native workflow/activity execution identities
   from history to the qualified cohort. An extra foreign poller or executor
   cannot qualify. The validation receipt is written only after successful
   fixture cleanup, lease release and database disconnect. Recover an existing
   receipt instead of replaying an indeterminate native operation.

5. After independent backend recovery has observed all eight runtimes, activate
   the exact build/attempt marker, require eight live production workflow/activity
   pollers and current process health, then CAS the saved previous pointer:

   ```bash
   npx tsx scripts/deploy-existing-worker-processes.ts activate --execute \
     --plan "$WORKER_PROCESS_PLAN" \
     --validation-receipt "$WORKER_PROCESS_VALIDATION"
   ```

   A recovered marker is inspected before any new activation. A third-party
   pointer or changed cohort fails closed. The backend needs a subsequent fresh
   RUNNING observation after the CLI releases its lease. Verify that certificate,
   exact pointer and process/native cohort before marking the Fly lane complete:

   ```bash
   npx tsx scripts/deploy-existing-worker-processes.ts verify-live --execute \
     --plan "$WORKER_PROCESS_PLAN"
   ```

The shared-host route does **not** call queue retirement or stop original workers.
Keep the original queue OPEN and served for protected runs, continuations and
later legitimate descendant starts. Legacy/ambiguous admission remains UNKNOWN;
this mode does not manufacture a retirement certificate. Do not run the classic
Machine-retirement or force-migration fallback against shared hosts. Actual
old-queue retirement is a separate, positively certified operation.

A successful process cutover completes only the worker lane. Run all remaining
production backend, workflow replacement, semantic frontend, evidence publication
and AgentCard lifecycle gates before declaring the deployment finished.
