#!/usr/bin/env bash
# Campaign-owned reuse of the existing fleet inventory publisher. No allocation.
set -uo pipefail
umask 077
ROOT_DIR="$1"; FLEET_DIR="$2"; INVENTORY_CAMPAIGN_PARENT_PID="$3"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SOURCE/cloudbench-env.sh"
MACHINE_READINESS_SCRIPT="$SOURCE/cloudbench-machine-readiness.py"
FLEET_OWNER_HOST="$(hostname)"
APP="navi-whisper-lux-bench"
INVENTORY_CAMPAIGN_PUBLISHER=1
source "$SOURCE/cloudbench-inventory.sh"
cd "$ROOT_DIR" || exit 1
if ! command -v flyctl >/dev/null 2>&1; then
    if [ -x "$HOME/.fly/bin/flyctl" ]; then export PATH="$HOME/.fly/bin:$PATH"; else
        echo "Fly client is not available for the campaign inventory" >&2; exit 1
    fi
fi
FLY_API_TOKEN="$(resolve_fly_token)"
[ -n "$FLY_API_TOKEN" ] || exit 1
export FLY_API_TOKEN
FLY() {
    if [ "$#" = 5 ] && [ "$1" = machines ] && [ "$2" = list ] \
        && [ "$3" = -a ] && [ "$4" = "$APP" ] && [ "$5" = --json ]; then
        python3 -S "$SOURCE/cloudbench-campaign-machines.py" "$APP" "$SNAPSHOT_REFRESH_TIMEOUT"
    else
        flyctl "$@"
    fi
}
SNAPSHOT_LOOP_PID=""
finish() {
    local status=$?
    trap - EXIT
    trap '' INT TERM HUP
    stop_owned_machines_snapshot_loop || status=1
    rm -f "$FLEET_DIR/owner"
    exit "$status"
}
trap finish EXIT
trap 'exit 143' INT TERM HUP
start_machines_snapshot_loop || exit 1
parent_birth="$(inventory_pid_start_time "$INVENTORY_CAMPAIGN_PARENT_PID")"
[ -n "$parent_birth" ] || exit 1
{
    printf 'app=%s\npid=%s\npid_start=%s\ntoken=%s\nparent_pid=%s\nparent_start=%s\n' \
        "$APP" "$SNAPSHOT_LOOP_PID" "$SNAPSHOT_LOOP_PID_START" "$SNAPSHOT_LOOP_TOKEN" \
        "$INVENTORY_CAMPAIGN_PARENT_PID" "$parent_birth"
} > "$FLEET_DIR/.owner.tmp" && mv "$FLEET_DIR/.owner.tmp" "$FLEET_DIR/owner" || exit 1
while [ ! -e "$FLEET_DIR/stop" ]; do
    kill -0 "$INVENTORY_CAMPAIGN_PARENT_PID" 2>/dev/null || exit 1
    inventory_pid_matches_start "$INVENTORY_CAMPAIGN_PARENT_PID" "$parent_birth" || exit 1
    kill -0 "$SNAPSHOT_LOOP_PID" 2>/dev/null || exit 1
    sleep 1
done
