#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cloudbench-boot.sh — the on-box BOOT entrypoint for the warm cloud box.
#
# Lives on the /data VOLUME (staged once at --setup, so every snapshot clone has
# it). The controller sets it as the machine's `--command` and delivers the
# per-run parameters as machine `--env` at `flyctl machine update` time, then
# starts the box. The box then AUTO-RUNS the driver on boot with NO controller
# SSH at all — which is the whole point: the per-box launch-ssh burst
# (start + ssh-ready + clear-stale + stage + launch + confirm ≈ 7 ssh × N boxes)
# saturated Fly's Machines-API rate limit at fleet width and killed drivers at
# launch. Boot-launch replaces that entire burst with one `machine update`
# (env + command) + one `machine start` per box — no ssh — and the controller
# polls progress over the Fly DATA PLANE (flyctl proxy → the status server below).
#
# Inputs (all machine --env, set per-box by run-bench-cloud):
#   CLOUDBENCH_BOOT=1        REQUIRED to run the driver; absent → idle (warm/clone source)
#   CLOUDBENCH_RUN_TOKEN     run token the controller matches in the log
#   REF                      branch/sha to check out + run
#   CLOUDBENCH_STATUS_PORT   http.server port serving /data (default 8011)
#   + every driver input (BENCH_TASKS_B64, BENCH_SIMULATE, WMH_MODEL_NAME,
#     CLOUDBENCH_START_BARRIER, …) — passed straight through to cloudbench-run.sh.
#
# Runs as the image's root CMD user. The driver drops to `rose` via gosu itself.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

LOG=/data/bench.log
REPO=/data/repo
STATUS_PORT="${CLOUDBENCH_STATUS_PORT:-8011}"

# Not a benchmark boot (the warm clone-source machine, or a bare manual start) →
# idle exactly like the image's original `sleep infinity` CMD.
if [ "${CLOUDBENCH_BOOT:-}" != "1" ]; then
    exec sleep infinity
fi

# /data (the snapshot-forked volume) can be briefly unwritable right at boot — the
# mount lands a beat after the command starts. Writing bench.log then silently
# fails (no set -e here) and the whole run produces an empty log. Wait until /data
# is actually writable before doing anything that touches it.
for _w in $(seq 1 120); do
    if touch /data/.cbwtest 2>/dev/null; then rm -f /data/.cbwtest 2>/dev/null; break; fi
    sleep 1
done

# RUNSTAMP first — the controller polls the log for this token to confirm the box
# actually booted into the driver (replaces the old ssh-written RUNSTAMP).
printf 'RUNSTAMP-%s\n' "${CLOUDBENCH_RUN_TOKEN:-boot}" > "$LOG"

# Data-plane status server: serve /data (which holds bench.log) over HTTP so the
# controller reads progress via `flyctl proxy` (WireGuard) — zero Machines-API
# cost, so N boxes polling can never saturate the control-plane rate limit. Bound
# to the box's private 6PN address, reachable only through the authenticated proxy.
pkill -f "http.server $STATUS_PORT" 2>/dev/null || true
setsid python3 -m http.server "$STATUS_PORT" --directory /data >/dev/null 2>&1 </dev/null &

# Bootstrap-checkout the ref so the REF's driver + helper scripts run (not the
# snapshot's stale copy). Reuse the battle-tested fetch-ref script, which builds a
# request-scoped http.extraheader from CLOUDBENCH_GITHUB_TOKEN_B64 (passed as a
# machine --env by the controller) — no token in the URL or the log. Its logic is
# stable across refs, so the snapshot's copy safely checks out the ref, after
# which the driver = the REF's cloudbench-run.sh. The driver re-runs git_sync too.
export CLOUDBENCH_APP_USER="${CLOUDBENCH_APP_USER:-rose}"
# Clear stale git locks the snapshot may carry. The ssh-launch path did this in its
# "clear-stale" step; boot-launch has no ssh, so do it here — a leftover
# .git/index.lock or cloudbench-fetch.lock (from a checkout that was in flight when
# the snapshot was taken) otherwise HANGS `git checkout`/`reset` indefinitely and
# every box stalls right after the fetch. Also kill any leftover driver/http.server.
pkill -TERM -f 'cloudbench-run.sh|run_benchmark.py|scripts/run.sh --benchmark' 2>/dev/null || true
rm -f "$REPO/.git/index.lock" "$REPO/.git/"*.lock "$REPO/.git/refs/heads/"*.lock \
      "$REPO/.git/cloudbench-fetch.lock" 2>/dev/null || true
{
    echo "[boot $(date -u +%H:%M:%S)] bootstrap-checkout ${REF:-<none>}"
    git config --global --add safe.directory "$REPO" 2>/dev/null || true
    if [ -n "${REF:-}" ] && [ -f "$REPO/scripts/cloudbench-fetch-ref.sh" ]; then
        bash "$REPO/scripts/cloudbench-fetch-ref.sh" "$REPO" "$REF" \
            || echo "[boot] bootstrap fetch-ref failed (driver git_sync will retry)"
    fi
} >> "$LOG" 2>&1

# Run the controller-injected driver, not the copy in the checkout. This matters
# for dirty-worktree validation: cloudbench-run.sh is the process that applies
# the uploaded patch, so changing that file via the patch is too late to alter
# its already-running control flow. Boot launch injects an immutable current
# copy at /cloudbench-run.sh alongside this boot script.
#
# Keep the Machine alive after the driver emits DONE. The
# controller polls every 15-20 seconds; exiting PID 1 immediately after DONE can
# stop Fly's data plane before the next poll, turning a genuine verdict into
# NORESULT. The controller persists the run-scoped marker payloads first and
# then explicitly stops/returns this Machine to the pool. If the driver crashes
# before DONE, /driver-health still reports it dead while this supervisor lives.
DRIVER=/cloudbench-run.sh
if [ ! -s "$DRIVER" ]; then
    printf '[boot %s] injected driver missing; falling back to checked-out ref\n' "$(date -u +%H:%M:%S)" >> "$LOG"
    DRIVER="$REPO/scripts/cloudbench-run.sh"
fi
bash "$DRIVER" >> "$LOG" 2>&1
driver_rc=$?
printf '[boot %s] driver exited rc=%s; holding for controller collection\n' \
    "$(date -u +%H:%M:%S)" "$driver_rc" >> "$LOG"
exec sleep infinity
