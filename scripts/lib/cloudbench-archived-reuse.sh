#!/usr/bin/env bash
# Explicit archived reuse; never add these identities to the generic warm pool.
archived_reuse_helper() { printf '%s/cloudbench-archived-machine-reuse.py' "${CLOUDBENCH_SCRIPT_SNAPSHOT:-$ROOT_DIR/scripts}"; }
archived_reuse_allocate() { # task output vm-profile; success+empty means no reserved candidate for ordinal
    [ "${CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE:-0}" != 1 ] || return 0
    [ -n "${CLOUDBENCH_ARCHIVED_REUSE_REQUEST:-}" ] || return 0
    local bench="$1" out="$2" ordinal mid record
    ordinal="$(python3 -S - "$bench" "${BENCHES[@]}" <<'PY'
import sys
print(sys.argv[2:].index(sys.argv[1]))
PY
)" || return 1
    python3 -S - "$out/archived-successor.json" "$BENCH_REF" "$RUN_ID" "$FLEET_OWNER_TOKEN" "$bench" "$ordinal" <<'PY'
import json,os,sys,runpy
from pathlib import Path
p,taskref,run,owner,task,ordinal=sys.argv[1:]
h=runpy.run_path(os.environ['CLOUDBENCH_SCRIPT_SNAPSHOT']+'/cloudbench-archived-machine-reuse.py')
h['save'](p,dict(controller_id=os.environ['FLY_MACHINE_ID'],harness_ref=os.environ['REVIEWED_OPERATOR_SOURCE_REF'],task_ref=taskref,owner_token=owner,run_id=run,task=task,ordinal=int(ordinal),campaign_job_id=os.environ.get('RUN_BENCH_CAMPAIGN_JOB_ID'),campaign_total_jobs=int(os.environ.get('RUN_BENCH_CAMPAIGN_TOTAL_JOBS','0')),campaign_attempt=int(os.environ.get('RUN_BENCH_CAMPAIGN_ATTEMPT','1'))))
PY
    mid="$(python3 -S "$(archived_reuse_helper)" allocate --request "$CLOUDBENCH_ARCHIVED_REUSE_REQUEST" --request-sha "$CLOUDBENCH_ARCHIVED_REUSE_REQUEST_SHA256" --ordinal "$ordinal" --successor "$out/archived-successor.json" --output "$out")" || return 1
    [ -n "$mid" ] || return 0
    python3 -S - "$(archived_reuse_helper)" "$out/archived-reuse-proof.json" "$FLEET_REGISTRY_DIR" "$FLEET_TEARDOWN_OWNERSHIP_DIR" "$GIT_COMMON_DIR" <<'PY'
import runpy,sys
from pathlib import Path
h=runpy.run_path(sys.argv[1]);proof=h['read_proof'](sys.argv[2]);mid=proof['machine_id']
for root in sys.argv[3:5]:h['exact_or_save'](Path(root)/'archived-reuse'/(mid+'.json'),proof)
h['exact_or_save'](Path(sys.argv[5])/'cloudbench-archived-reuse/current'/(mid+'.json'),proof)
PY
    printf 'archived-reuse %s\n' "$mid" > "$out/.cid"
    printf '%s\n' "$mid"
}
archived_reuse_retire_all() {
    local out failed=0
    for out in "$FLEET_DIR"/*; do
        [ -f "$out/archived-reuse-proof.json" ] || continue
        python3 -S "$(archived_reuse_helper)" retire --proof "$out/archived-reuse-proof.json" --journal "$out/archived-reuse-retirement" || failed=1
    done
    return "$failed"
}

archived_reuse_capacity_credit() {
    [ "${CLOUDBENCH_INFRA_CANARY_PREFLIGHT_ACTIVE:-0}" != 1 ] || { printf 0; return 0; }
    [ -n "${CLOUDBENCH_ARCHIVED_REUSE_REQUEST:-}" ] || { printf 0; return 0; }
    [ "${#BENCHES[@]}" = 1 ] || { echo "archived reuse requires original600 one-task campaign child" >&2; return 1; }
    python3 -S "$(archived_reuse_helper)" capacity-credit --task "${BENCHES[0]}"
}

archived_reuse_transport_args() {
    ARCHIVED_FLY_ARGS=("$@")
    local mid="" previous="" arg proof record
    for arg in "$@"; do
        if [ "$previous" = --machine ]; then mid="$arg"; fi
        previous="$arg"
    done
    [ -n "$mid" ] && [ -n "${GIT_COMMON_DIR:-}" ] || return 0
    proof="$GIT_COMMON_DIR/cloudbench-archived-reuse/current/$mid.json"
    [ -f "$proof" ] || return 0
    case "${1:-}:${2:-}" in
        ssh:console|ssh:sftp)
            record="$(mktemp)" || return 1
            if ! python3 -S "$(archived_reuse_helper)" transport --proof "$proof" -- "$@" > "$record"; then rm -f "$record"; return 1; fi
            ARCHIVED_FLY_ARGS=()
            while IFS= read -r -d '' arg; do ARCHIVED_FLY_ARGS+=("$arg"); done < "$record"
            rm -f "$record" ;;
        machine:destroy|machines:destroy|machine:stop|machines:stop|machine:restart|machines:restart)
            echo "archived successor retains ID; use exact leased archived retire CLI" >&2; return 1 ;;
    esac
}

archived_reuse_sftp_get() {
    [ "${1:-}:${2:-}:${3:-}" = ssh:sftp:get ] || return 2
    local mid="" previous="" arg proof remote="" destination=""
    for arg in "$@"; do
        if [ "$previous" = --machine ]; then mid="$arg"; fi
        previous="$arg"
        if [ -n "$remote" ]; then destination="$arg"; fi
        case "$arg" in /data/*) remote="$arg" ;; esac
    done
    [ -n "$mid" ] && [ -n "$remote" ] && [ -n "${GIT_COMMON_DIR:-}" ] || return 2
    proof="$GIT_COMMON_DIR/cloudbench-archived-reuse/current/$mid.json"
    [ -f "$proof" ] || return 2
    [ -n "$destination" ] || return 1
    python3 -S "$(archived_reuse_helper)" export-file --proof "$proof" --remote "$remote" --local "$destination"
}
