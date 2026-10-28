# Stop exact archived guests after an interrupted original600 controller

This standalone recovery command stops only sealed clone IDs from a verified
original controller export. It preserves Machines, volumes, config, ownership
claims, original failed outcomes and all evidence. STOPPED is a current native
observation, not full guest/provider-session cleanup or benchmark success.

Run outside the target controller after its gate/supervisor have joined and its
original archive/export is verified. The run directory must contain the original
`terminal.json`, `cleanup-call.intent.json`, `authority.private.json` and `export/`
with `originals.tar.gz`, `manifest.json`, `launch.json`, `caller.json` and
`disposable-export.verified.json`. Do not copy or fabricate these receipts to make
an unrelated archive fit. Input/output files must be private and owned by the
current user. A changed source identity, native config/instance/name/volume,
protected target, incomplete archive, live/unreleased controller or unowned
nonprotected Machine refuses the plan/action.

Use the selected authenticated CLI and explicit paths. Acquire ONE fresh full
native snapshot outside the controller, then prepare a no-provider plan:

```bash
umask 077
RUN_DIR=/absolute/path/to/original600-run
INVENTORY=/absolute/path/to/new-native-machines.private.json
OUTPUT=/absolute/path/to/new-exact-stop-evidence
AGENTS_ENV=/absolute/path/to/complete/agents.env
flyctl machines list -a navi-whisper-lux-bench --json > "$INVENTORY"
python3 scripts/cloudbench-archived-owner-stop.py \
  --run-dir "$RUN_DIR" --inventory "$INVENTORY" --out-dir "$OUTPUT"
```

The plan must report `PLANNED_NOT_STOPPED` and zero provider calls. Inspect its
exact IDs and protected cohort. To execute that SAME immutable plan:

```bash
python3 scripts/cloudbench-archived-owner-stop.py \
  --run-dir "$RUN_DIR" --inventory "$INVENTORY" --out-dir "$OUTPUT" \
  --agents-env "$AGENTS_ENV" --execute
```

The adapter uses at most16 bounded workers and the existing300-second overall
stop deadline. It exact-GETs each target and compares its frozen full config,
instance/name/creation identity before dispatching a single durable stop intent.
The only write is `POST /machines/EXACT_ID/stop`; no DELETE, start, config update,
volume detach or claim/latch release is permitted. The four explicitly protected
original Machines/volumes never become targets, including if they are started.
Unsealed archive create intents are skipped rather than promoted into ownership.
Both original `retain` and `reap` registries may authorize this narrower stop;
unknown policies refuse.

A response loss or deadline produces PENDING. Repeating the same command and
output directory reconciles existing target directories by GET ONLY; it never
reissues their stop POST. A late STOPPED observation can be recorded in a new
append-only observation receipt while prior PENDING evidence stays unchanged.
If a target remains active after its single attempted stop, it needs a separately
reviewed corrective action; do not remove intents or select a new output directory
as an automatic retry. A fresh capacity read/admission for the next experiment is
still required after all exact-owned targets are verified stopped.

An interrupted clone may have a successful creation acknowledgment in its
archived `primary.log` while its registry still contains only the requested
name. To stop those Machines, repeat `--acknowledged-create EXACT_MACHINE_ID`
for each selected ID in both commands above, using a separate output directory.
This mode targets only those IDs and requires the complete verified archive,
matching owner/name/source intent and audit records, one successful exact-ID
creation acknowledgment, and no conflicting allocation or successor claim.
It also checks the original image, region, empty-volume name and unchanged
`sleep infinity` init against the current native snapshot. The exact snapshot
config, instance and creation identity are checked again under the STOP lease.

This proof records the mounted volume as a **current observation**. It does not
rewrite the incomplete registry, manufacture historical volume ownership,
authorize reuse, release claims or certify guest cleanup. The default command
continues to skip incomplete records. Keep these IDs excluded from subsequent
reuse unless a separate supported protocol establishes that authority.

## Forensic current resource reconciliation after a deleted controller

An immutable exported owner can retain failed runtime evidence after its exact
resources have reached a native terminal disposition. The original audit and
missing historical epoch remain unchanged. The following separate forensic mode
requires a complete normal export, original joined/deleted controller receipts,
complete fresh disposable ownership and original delete authority. It never
restores a local registry, changes host identity, repeats DELETE or releases
historical evidence claims.

First obtain the normal fresh inventory required by the existing archived-owner
planner, and use the original shard run directory on the operator host. Inventory
must be a private regular file in a physical private directory and include the
protected warm cohort; do not restore archived registries into .git. All final
shards must retain their complete original archives and authority receipts:

```bash
umask 077
python3 scripts/cloudbench-archived-owner-stop.py \
  --run-dir "$ORIGINAL_SHARD_RUN" --inventory "$NATIVE_INVENTORY" \
  --out-dir "$PRIVATE_RECOVERY_DIR" \
  --forensic-resource-closure "$EXACT_OWNER"
python3 scripts/cloudbench-archived-owner-stop.py \
  --run-dir "$ORIGINAL_SHARD_RUN" --inventory "$NATIVE_INVENTORY" \
  --out-dir "$PRIVATE_RECOVERY_DIR" \
  --forensic-resource-closure "$EXACT_OWNER" \
  --agents-env "$AGENTS_ENV" --execute
```

In this explicit mode, `--execute` performs GET only. It first requires a
successful exact app identity, then exact terminal observations of the selected
controller and once-owned guest/volume IDs. Machines may return exact absence
or destroyed with the original creation/incarnation fields and config digest.
Volumes may instead have canonical pending_destroy/destroyed state when their
identity and original delete authority match. Live, foreign or unknown resources
refuse. The printed receipt path is content-bound
and append-only. This preliminary selected-owner receipt alone does not close
the admission.

Pass that exact receipt to the ordinary release-audit command's forensic
reconciliation mode:

```bash
python3 scripts/cloudbench-native-release-audit.py "$ORIGINAL_ADMISSION" \
  --forensic-closure "$EXACT_RECEIPT" --agents-env "$AGENTS_ENV"
```

The consumer verifies every final shard's complete export and joined/deleted
writer, derives all once-owned guest and controller workspace subjects, and
makes new native reads. It uses the ordinary full-scope inventory predicate to
catch active or newly unrecorded owned resources, then exact-GETs every known ID;
list omission is never proof. It preserves the original
`native-release-audit.json` bytes, inode and modification time. Its separate
`forensic-release-projection-*.json` can set
`current_physical_resource_release_verified: true` only after the complete fresh
scope is terminal. Exact 404 absence and an identity-matching Volume in canonical
`pending_destroy`/`destroyed` state remain distinct; soft deletion never becomes
an absence claim. The projection names its checked subjects and observation
clock and binds the raw observation receipt.

Original task results, INFRA, failed runtime capture, retained evidence claims
and missing historical provider epoch remain unchanged. Current resource
closure is not runtime sealing or historical task/lifecycle credit. Another
retained owner, incomplete/unallocated/borrowed cohort, foreign source, missing
original authority, active/unknown native state or the existing overall cleanup
deadline causes refusal. No automatic fallback or native mutation follows.

Both commands use the existing 300-second operation deadline, including receipt
publication. Timeout or interruption leaves no new success projection; partial
observation receipts may remain. Monitor the one exact command PID and its private
log. Observations are sequential facts as of the recorded clock, not an atomic
provider freeze or a guarantee against future resource creation.

If a prior plan refused, retain its directory and raw diagnostic wires. A newly
qualified terminal predicate changes the plan: obtain the normal fresh inventory
and choose a new private output directory, then run plan/execute/reconcile with
those exact inputs. Never edit an old plan to make it reusable. A native body
validation refusal retains a bounded raw response in a private 0600
`forensic-native-refusal-*.json`; its error exposes only subject, HTTP status and
an allowlisted state. Raw configs remain private.
