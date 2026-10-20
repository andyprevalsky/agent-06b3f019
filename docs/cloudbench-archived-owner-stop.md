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
