# shellcheck shell=bash
# Existing fleet inventory producer and readers, also borrowed by copy campaigns.
resolve_fly_token() {
    # Prefer a real bench token. Cloud/agent shells sometimes inject a stub
    # FLY_BENCH_API_TOKEN (len≪20) that shadows FLY_API_TOKEN and then fails
    # every machines list with token validation 401 — refuse stubs.
    if [ -n "${FLY_BENCH_API_TOKEN:-}" ] && [ "${#FLY_BENCH_API_TOKEN}" -ge 20 ]; then
        echo "$FLY_BENCH_API_TOKEN"
        return
    fi
    if [ -n "${FLY_BENCH_API_TOKEN:-}" ]; then
        echo "⚠️  ignoring stub FLY_BENCH_API_TOKEN (len=${#FLY_BENCH_API_TOKEN}); falling back" >&2
    fi
    local cfg="$HOME/.fly/config.yml"
    if [ -f "$cfg" ]; then
        local t; t="$(grep -E '^access_token:' "$cfg" 2>/dev/null | head -1 | sed 's/^access_token:[[:space:]]*//; s/^["'\'']//; s/["'\'']$//')"
        [ -n "$t" ] && { echo "$t"; return; }
    fi
    if [ -n "${FLY_API_TOKEN:-}" ]; then echo "$FLY_API_TOKEN"; return; fi
    grep -E '^FLY_API_TOKEN=' agents/.env 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'
}

registry_meta_value() {  # registry_meta_value <meta-file> <key>
    local meta="$1" key="$2"
    sed -n "s/^${key}=//p" "$meta" 2>/dev/null | head -1
}

inventory_pid_start_time() {
    if [ -r /proc/self/stat ]; then
        cloudbench_pid_start_time "$1"
    else
        ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
    fi
}

inventory_pid_matches_start() {  # <pid> <recorded-identity>
    local observed
    [ -n "$2" ] || return 1
    case "$2" in
        proc-start:*) cloudbench_pid_matches_start "$1" "$2" ;;
        *)
            observed="$(ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
            [ -n "$observed" ] && [ "$observed" = "$2" ]
            ;;
    esac
}

fly_with_timeout() {  # fly_with_timeout <seconds> <FLY args...>
    local secs="$1"; shift
    case "$secs" in ''|*[!0-9]*) return 2 ;; esac
    while [ "${secs#0}" != "$secs" ]; do secs="${secs#0}"; done
    [ -n "$secs" ] || return 142
    local out notify_fd read_fd pid rc read_status=0 completed running
    local child_birth=unknown returned=unknown marker_pid marker_birth marker_rc marker_extra stat_line local_shell_pid marker_shell_flags completion_markers_safe=1 completion_token marker_token returned_pid returned_birth
    local -a stat_fields
    out="$(mktemp)" || return 1
    if ! mkfifo -m 600 "$out.done"; then
        rm -f "$out"
        return 1
    fi
    # The controller already requires modern Bash. A timed FIFO read blocks
    # until the owning shell exits, including its EXIT handlers, without a
    # polling sleeper or an independently owned watchdog.
    if ! exec {notify_fd}<> "$out.done"; then
        rm -f "$out.done" "$out"
        return 1
    fi
    if ! exec {read_fd}< "$out.done"; then
        exec {notify_fd}>&-
        rm -f "$out.done" "$out"
        return 1
    fi
    rm -f "$out.done"
    # Existing siblings are not evidence from this invocation. An invocation
    # token additionally binds records to this exact wrapper rather than a PID.
    [ ! -e "$out.started" ] && [ ! -L "$out.started" ] && \
        [ ! -e "$out.returned" ] && [ ! -L "$out.returned" ] || completion_markers_safe=0
    completion_token="$BASHPID-$RANDOM-$RANDOM"
    (
        exec {read_fd}<&-
        # Keep the writer through native exec and EXIT handlers. Production
        # FLY owns a foreground flyctl; detached writers fail at the deadline.
        # Private, best-effort completion evidence only. No marker grants success;
        # the original FIFO EOF plus wait status remains the acceptance boundary.
        local_shell_pid="$BASHPID"
        child_birth=unknown
        if [ -r "/proc/$BASHPID/stat" ]; then
            IFS= read -r stat_line < "/proc/$BASHPID/stat" || true
            stat_line="${stat_line##*) }"
            read -r -a stat_fields <<< "$stat_line"
            child_birth="${stat_fields[19]:-unknown}"
        fi
        marker_shell_flags="$-"
        set -C
        { [ "$completion_markers_safe" = 1 ] && printf '%s %s %s\n' "$completion_token" "$local_shell_pid" "$child_birth" > "$out.started"; } 2>/dev/null || true
        case "$marker_shell_flags" in *C*) ;; *) set +C ;; esac
        if FLY "$@" >"$out" 2>&1; then rc=0; else rc=$?; fi
        marker_shell_flags="$-"
        set -C
        { [ "$completion_markers_safe" = 1 ] && printf '%s %s %s %s\n' "$completion_token" "$local_shell_pid" "$child_birth" "$rc" > "$out.returned"; } 2>/dev/null || true
        case "$marker_shell_flags" in *C*) ;; *) set +C ;; esac
        exit "$rc"
    ) &
    pid=$!
    exec {notify_fd}>&-
    IFS= read -r -t "$secs" -u "$read_fd" completed || read_status=$?
    exec {read_fd}<&-
    if [ "$read_status" -ne 1 ]; then
        if [ "$completion_markers_safe" = 1 ] && [ -f "$out.started" ] && [ ! -L "$out.started" ]; then
            IFS=' ' read -r marker_token marker_pid marker_birth marker_extra < "$out.started" || true
            if [ "${marker_token:-}" = "$completion_token" ] && [ "${marker_pid:-}" = "$pid" ] && [ -z "${marker_extra:-}" ]; then
                case "${marker_birth:-}" in ''|*[!0-9]*) ;; *) child_birth="$marker_birth" ;; esac
            fi
        fi
        if [ "$completion_markers_safe" = 1 ] && [ -f "$out.returned" ] && [ ! -L "$out.returned" ]; then
            IFS=' ' read -r marker_token returned_pid returned_birth marker_rc marker_extra < "$out.returned" || true
            case "${marker_rc:-}" in ''|*[!0-9]*) ;; *)
                [ "${marker_token:-}" = "$completion_token" ] && [ "${returned_pid:-}" = "$pid" ] && \
                    [ "${returned_birth:-}" = "$child_birth" ] && [ -z "${marker_extra:-}" ] && returned="$marker_rc" ;;
            esac
        fi
        printf '[warn] FLY_COMPLETION_TIMEOUT shell_pid=%s shell_start_ticks=%s fly_return_status=%s fifo_read_status=%s\n' \
            "$pid" "$child_birth" "$returned" "$read_status" >&2
        # Only EOF establishes completion. Deadline, interrupted read, and
        # invalid/read-error statuses must never fall through to an unbounded
        # successful wait. A shell job check avoids signalling a reused PID if
        # an unsupported detached descendant retained a FIFO descriptor.
        # Signal the native children first and keep their wrapper shell alive:
        # while it runs, `-P "$pid"` still names exactly this invocation's
        # children. Terminating the wrapper first reparents a TERM-surviving
        # flyctl to init, where the KILL escalation can no longer reach it.
        running="$(jobs -pr)"
        if [[ $'\n'"$running"$'\n' == *$'\n'"$pid"$'\n'* ]]; then
            pkill -TERM -P "$pid" 2>/dev/null || true
            local grace
            for grace in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
                running="$(jobs -pr)"
                [[ $'\n'"$running"$'\n' == *$'\n'"$pid"$'\n'* ]] || break
                sleep 0.1
            done
            if [[ $'\n'"$running"$'\n' == *$'\n'"$pid"$'\n'* ]]; then
                pkill -KILL -P "$pid" 2>/dev/null || true
                for grace in 1 2 3 4 5 6 7 8 9 10; do
                    running="$(jobs -pr)"
                    [[ $'\n'"$running"$'\n' == *$'\n'"$pid"$'\n'* ]] || break
                    sleep 0.1
                done
                if [[ $'\n'"$running"$'\n' == *$'\n'"$pid"$'\n'* ]]; then
                    kill -KILL "$pid" 2>/dev/null || true
                fi
            fi
        fi
        wait "$pid" 2>/dev/null || true
        cat "$out"; rm -f "$out"
        [ "$completion_markers_safe" != 1 ] || rm -f "$out.started" "$out.returned"
        [ "$read_status" -gt 128 ] && return 142
        return 1
    fi
    if wait "$pid"; then rc=0; else rc=$?; fi
    cat "$out"; rm -f "$out"
    [ "$completion_markers_safe" != 1 ] || rm -f "$out.started" "$out.returned"
    return "$rc"
}

# ── ONE shared inventory stream for every read-only poller ──────────────────
# A single controller-owned loop reads Fly's Machines/Volumes APIs and publishes
# an atomic, keyed per-machine index. Hot consumers read one tiny record instead
# of issuing N provider calls or parsing an N-machine array in each of N children.
# Provider load stays O(1) and local index work stays O(N) at fleet width.
# Mutating paths that need post-write freshness (reap verification, pool claims)
# intentionally stay live and bounded.
INVENTORY_HOME="${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-$FLEET_DIR}"
MACHINES_SNAPSHOT="$INVENTORY_HOME/machines.json"
VOLUMES_SNAPSHOT="$INVENTORY_HOME/volumes.json"
INVENTORY_INDEX="$INVENTORY_HOME/inventory"
# The native app-wide list includes inline Machine files (~20 MB at width 10).
# A five-second refresh cadence floods Fly with redundant transfer during
# startup; readiness paths that need an immediate post-mutation view still use
# the serialized explicit refresh below.
SNAPSHOT_POLL="${CLOUDBENCH_SNAPSHOT_POLL_SECONDS:-15}"
SNAPSHOT_REFRESH_TIMEOUT="${CLOUDBENCH_SNAPSHOT_REFRESH_TIMEOUT_SECONDS:-30}"
INVENTORY_REFRESH_LOCK="$INVENTORY_HOME/machines-refresh.lock"
INVENTORY_WAIT_FIFO="$INVENTORY_HOME/inventory-refresh.wait"
# A busy Fly API can stall several consecutive bounded list requests while a
# width-10 fleet starts. Preserve the last successfully published inventory
# through that burst; the live publisher PID/token fence and the finite expiry
# still fail closed if the provider feed actually stops recovering.
INVENTORY_MAX_STALE_SECONDS="${CLOUDBENCH_INVENTORY_MAX_STALE_SECONDS:-$((SNAPSHOT_REFRESH_TIMEOUT * 20))}"
INVENTORY_CLOCK_EPOCH="$(date +%s)"
INVENTORY_CLOCK_SECONDS="$SECONDS"

inventory_refresh_diagnostic() {  # <phase> <native-status|pending> <private-output> <started-SECONDS>
    local phase="$1" status="$2" raw="${3:-}" started="${4:-$SECONDS}" phase_source="${5:-}"
    local directory="${INVENTORY_HOME:-$FLEET_DIR}/inventory-refresh-diagnostics" temporary private_tmp
    [ -d "$directory" ] || mkdir -m 700 "$directory" || return 1
    [ ! -L "$directory" ] || return 1
    temporary="$(mktemp "$directory/.latest.XXXXXX")" || return 1
    {
        printf 'phase=%s\nstatus=%s\nepoch=%s\nelapsed_seconds=%s\npid=%s\n' \
            "$phase" "$status" "$(date +%s)" "$((SECONDS - started))" "${BASHPID:-$$}"
        printf 'publisher_token=%s\n' "${SNAPSHOT_LOOP_TOKEN:-}"
    } > "$temporary" || { rm -f "$temporary"; return 1; }
    chmod 600 "$temporary" && mv "$temporary" "$directory/latest" || return 1
    # Keep a compact, secret-free timeline. `latest` alone loses the reason for
    # a provider outage when the next retry overwrites its failure status.
    if [ "$status" != pending ]; then
        printf '%s\t%s\t%s\t%s\n' "$(date +%s)" "$phase" "$status" "$((SECONDS - started))" \
            >> "$directory/history" || return 1
        chmod 600 "$directory/history" || return 1
    fi
    # The helper writes only allowlisted phase rows to its exclusive private
    # sidecar. Keep these separate from native JSON; diagnostics grant nothing.
    if [ -n "$phase_source" ] && [ -f "$phase_source" ] && [ ! -L "$phase_source" ]; then
        private_tmp="$(mktemp "$directory/.phase.XXXXXX")" || return 1
        if cp "$phase_source" "$private_tmp" && chmod 600 "$private_tmp" \
            && mv "$private_tmp" "$directory/phase.latest.private"; then
            case "$status" in
                pending|0) rm -f "$phase_source" ;;
                *)
                    private_tmp="$(mktemp "$directory/.failure-phase.XXXXXX")" || return 1
                    if cp "$phase_source" "$private_tmp" && chmod 600 "$private_tmp" \
                        && mv "$private_tmp" "$directory/failure.phase.private"; then
                        rm -f "$phase_source"
                    fi
                    ;;
            esac
        fi
    fi
    case "$status" in pending|0) return 0 ;; esac
    private_tmp="$(mktemp "$directory/.failure.XXXXXX")" || return 1
    if [ -f "$raw" ] && [ ! -L "$raw" ]; then
        cp "$raw" "$private_tmp" || { rm -f "$private_tmp"; return 1; }
    fi
    chmod 600 "$private_tmp" && mv "$private_tmp" "$directory/failure.raw.private"
}

_refresh_inventory_snapshot_unlocked() {
    local suffix machines_tmp volumes_tmp publish_tmp phase_tmp started status=0
    # Native Machine JSON can contain configured env and files. Keep even
    # short-lived snapshots private before any diagnostic copy is made.
    umask 077
    started=$SECONDS
    suffix="${BASHPID:-$$}.$RANDOM"
    machines_tmp="$MACHINES_SNAPSHOT.tmp.$suffix"
    volumes_tmp="$VOLUMES_SNAPSHOT.tmp.$suffix"
    phase_tmp="${INVENTORY_HOME:-$FLEET_DIR}/inventory-refresh-diagnostics/.machines-phase.$suffix"
    publish_tmp="${INVENTORY_HOME:-$FLEET_DIR}/inventory-publish.tmp.$suffix"
    # Pinned flyctl sends headless CLI analytics after JSON. Keep that optional
    # finalizer out of these bounded reads; native EOF/status still decide success.
    inventory_refresh_diagnostic machines-list pending "" "$started" || true
    CLOUDBENCH_INVENTORY_PHASE_FILE="$phase_tmp" FLY_SEND_METRICS=0 \
        fly_with_timeout "$SNAPSHOT_REFRESH_TIMEOUT" machines list -a "$APP" --json > "$machines_tmp" || status=$?
    if [ "$status" -ne 0 ] || [ ! -s "$machines_tmp" ]; then
        [ "$status" -ne 0 ] || status=1
        inventory_refresh_diagnostic machines-list "$status" "$machines_tmp" "$started" "$phase_tmp" || true
        rm -f "$machines_tmp" "$volumes_tmp"
        return 1
    fi
    inventory_refresh_diagnostic volumes-list pending "" "$started" "$phase_tmp" || true
    status=0
    FLY_SEND_METRICS=0 fly_with_timeout "$SNAPSHOT_REFRESH_TIMEOUT" \
        volumes list -a "$APP" --json > "$volumes_tmp" || status=$?
    if [ "$status" -ne 0 ] || [ ! -s "$volumes_tmp" ]; then
        [ "$status" -ne 0 ] || status=1
        inventory_refresh_diagnostic volumes-list "$status" "$volumes_tmp" "$started" || true
        rm -f "$machines_tmp" "$volumes_tmp"
        return 1
    fi
    inventory_refresh_diagnostic publish-index pending "" "$started" || true
    status=0
    python3 -S "$MACHINE_READINESS_SCRIPT" --publish-index \
        "$machines_tmp" "$volumes_tmp" "$INVENTORY_INDEX" > "$publish_tmp" 2>&1 || status=$?
    if [ "$status" -ne 0 ]; then
        inventory_refresh_diagnostic publish-index "$status" "$publish_tmp" "$started" || true
        rm -f "$machines_tmp" "$volumes_tmp" "$publish_tmp"
        return 1
    fi
    rm -f "$publish_tmp"
    if ! mv "$machines_tmp" "$MACHINES_SNAPSHOT" \
        || ! mv "$volumes_tmp" "$VOLUMES_SNAPSHOT"; then
        inventory_refresh_diagnostic snapshot-files 1 "" "$started" || true
        rm -f "$machines_tmp" "$volumes_tmp"
        return 1
    fi
    inventory_refresh_diagnostic complete 0 "" "$started" || true
}

inventory_refresh_wait_tick() {
    # A read timeout on a read/write FIFO is a Bash builtin wait: no child
    # process per clone-name waiter while another publisher owns the lock.
    [ -p "$INVENTORY_WAIT_FIFO" ] || return 1
    exec 19<> "$INVENTORY_WAIT_FIFO" || return 1
    IFS= read -r -t 1 -u 19 _inventory_wait_value || true
    exec 19>&-
}

inventory_refresh_lock_acquire() {  # inventory_refresh_lock_acquire [prior-generation]
    # Publish complete ownership metadata as an atomic hard link. A SIGKILL can
    # leave either no lock or a complete lock file, never the metadata-less
    # directory window that previously outlived the waiter budget.
    local lock="$INVENTORY_REFRESH_LOCK" prior="${1:-}" candidate=""
    local owner_pid="" owner_start="" token="" initialized=0 current
    local status lock_host lock_pid key value wait_seconds deadline
    wait_seconds="${CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS:-$((SNAPSHOT_REFRESH_TIMEOUT * 3 + 5))}"
    case "$wait_seconds" in
        ''|*[!0-9]*) return 1 ;;
    esac
    deadline=$((SECONDS + wait_seconds))
    while :; do
        if [ -n "$prior" ]; then
            current="$(machines_snapshot_identity)"
            if [ "$current" != "$prior" ]; then
                [ -n "$candidate" ] && rm -f "$candidate"
                return 2
            fi
        fi

        if [ ! -e "$lock" ]; then
            if [ "$initialized" = "0" ]; then
                owner_pid="${BASHPID:-$$}"
                owner_start="$(inventory_pid_start_time "$owner_pid")"
                [ -n "$owner_start" ] || return 1
                token="$owner_pid.$RANDOM.$RANDOM.$SECONDS"
                candidate="$lock.candidate.$owner_pid.$RANDOM"
                {
                    printf 'host=%s\n' "$FLEET_OWNER_HOST"
                    printf 'pid=%s\n' "$owner_pid"
                    printf 'pid_start=%s\n' "$owner_start"
                    printf 'token=%s\n' "$token"
                } > "$candidate" || { rm -f "$candidate"; return 1; }
                initialized=1
            fi
            if ln "$candidate" "$lock" 2>/dev/null; then
                rm -f "$candidate"
                INVENTORY_REFRESH_LOCK_TOKEN="$token"
                INVENTORY_REFRESH_LOCK_OWNER_PID="$owner_pid"
                INVENTORY_REFRESH_LOCK_OWNER_PID_START="$owner_start"
                export CLOUDBENCH_INVENTORY_REFRESH_LOCK="$lock"
                export CLOUDBENCH_INVENTORY_REFRESH_LOCK_TOKEN="$token"
                return 0
            fi
        fi

        lock_host=""; lock_pid=""
        if [ -f "$lock" ]; then
            while IFS='=' read -r key value; do
                case "$key" in host) lock_host="$value" ;; pid) lock_pid="$value" ;; esac
            done < "$lock"
        fi
        if [ -n "$lock_host" ] && [ "$lock_host" != "$FLEET_OWNER_HOST" ]; then
            [ -n "$candidate" ] && rm -f "$candidate"
            echo "❌ inventory refresh lock belongs to another host" >&2
            return 1
        fi
        case "$lock_pid" in
            ''|*[!0-9]*) status=1 ;;
            *) kill -0 "$lock_pid" 2>/dev/null && status=0 || status=1 ;;
        esac
        if [ "$status" = "1" ]; then
            if python3 "$MACHINE_READINESS_SCRIPT" --recover-lock "$lock"; then
                continue
            else
                status=$?
                [ "$status" -eq 1 ] || {
                    [ -n "$candidate" ] && rm -f "$candidate"
                    echo "❌ unsafe inventory refresh lock recovery" >&2
                    return 1
                }
            fi
        fi
        if [ "$SECONDS" -ge "$deadline" ]; then
            [ -n "$candidate" ] && rm -f "$candidate"
            echo "❌ timed out waiting for the serialized inventory refresh" >&2
            return 1
        fi
        inventory_refresh_wait_tick || {
            [ -n "$candidate" ] && rm -f "$candidate"
            return 1
        }
    done
}

inventory_refresh_lock_release() {
    local lock="$INVENTORY_REFRESH_LOCK" owner_pid
    local lock_host lock_pid lock_start lock_token
    local sealed_owner_pid sealed_owner_start
    owner_pid="${BASHPID:-$$}"
    sealed_owner_pid="${INVENTORY_REFRESH_LOCK_OWNER_PID:-}"
    sealed_owner_start="${INVENTORY_REFRESH_LOCK_OWNER_PID_START:-}"
    lock_host="$(registry_meta_value "$lock" host)"
    lock_pid="$(registry_meta_value "$lock" pid)"
    lock_start="$(registry_meta_value "$lock" pid_start)"
    lock_token="$(registry_meta_value "$lock" token)"
    [ "$lock_host" = "$FLEET_OWNER_HOST" ] \
        && [ "$owner_pid" = "$sealed_owner_pid" ] \
        && [ "$lock_pid" = "$sealed_owner_pid" ] \
        && [ "$lock_start" = "$sealed_owner_start" ] \
        && [ "$lock_token" = "${INVENTORY_REFRESH_LOCK_TOKEN:-}" ] \
        || return 1
    rm -f "$lock"
    unset INVENTORY_REFRESH_LOCK_TOKEN INVENTORY_REFRESH_LOCK_OWNER_PID \
        INVENTORY_REFRESH_LOCK_OWNER_PID_START
    unset CLOUDBENCH_INVENTORY_REFRESH_LOCK CLOUDBENCH_INVENTORY_REFRESH_LOCK_TOKEN
}

refresh_inventory_snapshot() {
    local status=0
    inventory_refresh_lock_acquire || return 1
    _refresh_inventory_snapshot_unlocked || status=$?
    inventory_refresh_lock_release || return 1
    return "$status"
}

machines_snapshot_loop() {
    local backoff=0
    while :; do
        if refresh_inventory_snapshot; then
            backoff=0
        else
            # rate-limited/transient API failure: back off (bounded) and keep
            # serving the last good index rather than hammering the API.
            backoff=$(( backoff < 15 ? backoff + 5 : 15 ))
        fi
        sleep $(( SNAPSHOT_POLL + backoff + (RANDOM % 3) ))
    done
}

campaign_inventory_borrow() {
    local owner="$INVENTORY_HOME/owner" key value app="" pid="" birth="" token="" parent="" parent_birth=""
    [ -f "$owner" ] && [ ! -L "$owner" ] || return 1
    while IFS='=' read -r key value; do
        case "$key" in app) app="$value" ;; pid) pid="$value" ;; pid_start) birth="$value" ;; token) token="$value" ;; parent_pid) parent="$value" ;; parent_start) parent_birth="$value" ;; esac
    done < "$owner"
    [ "$app" = "$APP" ] && [ -n "$token" ] || return 1
    case "$pid:$parent" in *[!0-9:]*|:*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null && kill -0 "$parent" 2>/dev/null || return 1
    inventory_pid_matches_start "$pid" "$birth" || return 1
    inventory_pid_matches_start "$parent" "$parent_birth" || return 1
    SNAPSHOT_LOOP_PID="$pid"
    SNAPSHOT_LOOP_PID_START="$birth"
    SNAPSHOT_LOOP_TOKEN="$token"
    INVENTORY_CAMPAIGN_PARENT_PID="$parent"
    INVENTORY_CAMPAIGN_PARENT_START="$parent_birth"
    INVENTORY_PUBLISHER_BORROWED=1
    export CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN="$token"
    export CLOUDBENCH_INVENTORY_MAX_STALE_SECONDS="$INVENTORY_MAX_STALE_SECONDS"
    inventory_index_healthy
}

stop_owned_machines_snapshot_loop() {
    [ "${INVENTORY_PUBLISHER_BORROWED:-0}" != 1 ] || return 0
    cloudbench_terminate_tree_and_wait "${CLOUDBENCH_CHILD_TERM_SECONDS:-30}" "${SNAPSHOT_LOOP_PID:-}" || return 1
    SNAPSHOT_LOOP_PID=""
    [ -n "${INVENTORY_WAIT_FIFO:-}" ] && rm -f "$INVENTORY_WAIT_FIFO" 2>/dev/null || true
}

start_machines_snapshot_loop() {
    if [ -n "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ] && [ "${INVENTORY_CAMPAIGN_PUBLISHER:-0}" != 1 ]; then
        campaign_inventory_borrow
        return $?
    fi
    [ -n "${SNAPSHOT_LOOP_PID:-}" ] && kill -0 "$SNAPSHOT_LOOP_PID" 2>/dev/null \
        && return 0
    SNAPSHOT_LOOP_TOKEN="${SNAPSHOT_LOOP_TOKEN:-$RANDOM.$RANDOM.$$.${SECONDS}}"
    export CLOUDBENCH_INVENTORY_PUBLISHER_TOKEN="$SNAPSHOT_LOOP_TOKEN"
    export CLOUDBENCH_INVENTORY_MAX_STALE_SECONDS="$INVENTORY_MAX_STALE_SECONDS"
    if [ -e "$INVENTORY_WAIT_FIFO" ] && [ ! -p "$INVENTORY_WAIT_FIFO" ]; then
        echo "❌ invalid inventory refresh wait path" >&2
        return 1
    fi
    [ -p "$INVENTORY_WAIT_FIFO" ] || mkfifo "$INVENTORY_WAIT_FIFO" || return 1
    if ! refresh_inventory_snapshot; then
        echo "❌ shared inventory snapshot did not initialize" >&2
        return 1
    fi
    machines_snapshot_loop & SNAPSHOT_LOOP_PID=$!
    SNAPSHOT_LOOP_PID_START="$(inventory_pid_start_time "$SNAPSHOT_LOOP_PID")"
    if [ -z "$SNAPSHOT_LOOP_PID_START" ]; then
        kill "$SNAPSHOT_LOOP_PID" 2>/dev/null || true
        SNAPSHOT_LOOP_PID=""
        return 1
    fi
}

inventory_index_healthy() {
    local pid="${SNAPSHOT_LOOP_PID:-}" expected_token="${SNAPSHOT_LOOP_TOKEN:-}"
    local key value publisher_token="" valid_until="" now status=0 health="$INVENTORY_INDEX/current/health"
    case "$pid" in ''|*[!0-9]*) return 1 ;; esac
    kill -0 "$pid" 2>/dev/null || return 1
    if [ -n "${SNAPSHOT_LOOP_PID_START:-}" ]; then
        inventory_pid_matches_start "$pid" "$SNAPSHOT_LOOP_PID_START" || return 1
    fi
    if [ "${INVENTORY_PUBLISHER_BORROWED:-0}" = 1 ]; then
        kill -0 "$INVENTORY_CAMPAIGN_PARENT_PID" 2>/dev/null || return 1
        inventory_pid_matches_start "$INVENTORY_CAMPAIGN_PARENT_PID" \
            "$INVENTORY_CAMPAIGN_PARENT_START" || return 1
    fi
    [ -n "$expected_token" ] && [ ! -L "$health" ] || return 1
    # A live, birth-fenced publisher can be between usable generations. Only
    # availability/freshness is retryable; malformed ownership remains fatal.
    [ -e "$health" ] || return 75
    [ -f "$health" ] && [ -s "$health" ] || return 1
    [ -r "$health" ] || return 75
    while IFS='=' read -r key value; do
        case "$key" in
            publisher_token) publisher_token="$value" ;;
            valid_until) valid_until="$value" ;;
        esac
    done < "$health" || return 75
    case "$valid_until" in ''|*[!0-9]*) return 1 ;; esac
    [ "$publisher_token" = "$expected_token" ] || return 1
    now=$((INVENTORY_CLOCK_EPOCH + SECONDS - INVENTORY_CLOCK_SECONDS))
    [ "$valid_until" -ge "$now" ] || status=$?
    case "$status" in 0) return 0 ;; 1) return 75 ;; *) return 1 ;; esac
}

_fresh_snapshot_or() {  # _fresh_snapshot_or <snapshot-file> <live-cmd...>
    # Once shared mode starts, every consumer either reads the last good snapshot
    # or fails closed. A stale/missing snapshot must never fan out into one live
    # provider request per child during the exact rate-limit condition we absorb.
    local f="$1"; shift
    if [ -n "${SNAPSHOT_LOOP_PID:-}" ]; then
        inventory_index_healthy || return $?
        [ -s "$f" ] || return 75
        cat "$f"
        return $?
    fi
    "$@" 2>/dev/null
}
fleet_machines_json() { _fresh_snapshot_or "$MACHINES_SNAPSHOT" FLY machines list -a "$APP" --json; }
fleet_admission_machines_json() {
    # Borrow the original campaign publisher even during warm-source lookup;
    # never retain app-wide inline boot payloads in each waiting controller.
    if [ -n "${CLOUDBENCH_CAMPAIGN_INVENTORY_DIR:-}" ]; then
        [ -n "${SNAPSHOT_LOOP_PID:-}" ] || return 75
        _fresh_snapshot_or "$INVENTORY_INDEX/current/admission-machines.json" FLY machines list -a "$APP" --json
        return $?
    fi
    fleet_machines_json
}
fleet_volumes_json()  { _fresh_snapshot_or "$VOLUMES_SNAPSHOT" FLY volumes list -a "$APP" --json; }

inventory_borrowed_generation_wait_seconds() {
    # A borrower cannot refresh the parent feed. One healthy publication cycle is
    # the publisher's deliberate sleep (poll plus at most two seconds of jitter)
    # followed by the existing bounded refresh budget. Sharded campaigns lengthen
    # the poll (60 s at 20 controllers); a budget sized for 15 s cannot cover it.
    printf '%s' "${CLOUDBENCH_SNAPSHOT_REFRESH_WAIT_SECONDS:-$((SNAPSHOT_POLL + 2 + SNAPSHOT_REFRESH_TIMEOUT * 3 + 5))}"
}

machines_snapshot_identity() {
    local key value generation="missing"
    [ -s "$INVENTORY_INDEX/current/health" ] || { printf '%s' "$generation"; return; }
    while IFS='=' read -r key value; do
        [ "$key" = "generation" ] && generation="$value"
    done < "$INVENTORY_INDEX/current/health"
    printf '%s' "$generation"
}

refresh_machines_snapshot_after() {  # <prior-identity> [original-caller-deadline]
    if [ "${INVENTORY_PUBLISHER_BORROWED:-0}" = 1 ]; then
        # Post-mutation borrowers must observe a NEW healthy parent generation.
        # They never become a second producer or take its refresh mutex: a slow
        # child native CLI would otherwise prevent the healthy parent publishing.
        local borrowed_prior="$1" before after health_status wait_seconds deadline caller_deadline="${2:-}"
        wait_seconds="$(inventory_borrowed_generation_wait_seconds)"
        case "$wait_seconds" in ''|*[!0-9]*) return 1 ;; esac
        deadline=$((SECONDS + wait_seconds))
        if [ -n "$caller_deadline" ]; then
            case "$caller_deadline" in *[!0-9]*) return 1 ;; esac
            [ "$caller_deadline" -ge "$deadline" ] || deadline="$caller_deadline"
        fi
        while [ "$SECONDS" -lt "$deadline" ]; do
            before="$(machines_snapshot_identity)"
            health_status=0
            inventory_index_healthy || health_status=$?
            case "$health_status" in
                0)
                    after="$(machines_snapshot_identity)"
                    if [ -n "$before" ] && [ "$before" != missing ] && \
                        [ "$before" = "$after" ] && [ "$before" != "$borrowed_prior" ]; then
                        [ "$SECONDS" -lt "$deadline" ] || return 1
                        return 0
                    fi
                    ;;
                75) ;;  # Only real live, birth/token-fenced availability is pending.
                *) return 1 ;;
            esac
            inventory_refresh_wait_tick || return 1
        done
        echo "❌ timed out waiting for a new healthy parent inventory generation" >&2
        return 1
    fi
    # Clone output very rarely omits the target id. All exceptional resolvers
    # coalesce behind one bounded refresh. The lock carries a process-start
    # identity so a SIGKILLed owner can never wedge every later refresh.
    local prior="$1" current status=0
    current="$(machines_snapshot_identity)"
    [ "$current" != "$prior" ] && return 0
    if inventory_refresh_lock_acquire "$prior"; then
        :
    else
        status=$?
        [ "$status" = "2" ] && return 0
        return 1
    fi
    current="$(machines_snapshot_identity)"
    if [ "$current" = "$prior" ]; then
        _refresh_inventory_snapshot_unlocked || status=$?
    fi
    inventory_refresh_lock_release || return 1
    return "$status"
}

inventory_machine_record_path() {  # inventory_machine_record_path <id>
    case "$1" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
    printf '%s' "$INVENTORY_INDEX/current/machines/$1"
}

inventory_machine_field() {  # inventory_machine_field <id> <field>
    local path key value
    inventory_index_healthy || return $?
    path="$(inventory_machine_record_path "$1")" || return 1
    [ -s "$path" ] || return 1
    while IFS='=' read -r key value; do
        [ "$key" = "$2" ] && { printf '%s' "$value"; return 0; }
    done < "$path"
    return 1
}

inventory_machine_exists() {
    local path status=0
    path="$(inventory_machine_record_path "$1")" || return 2
    # A stale publisher cannot establish Machine absence. Preserve that
    # distinction for autoscaler diagnostics and exact-owner recovery.
    inventory_index_healthy || status=$?
    [ "$status" -ne 75 ] || return 75
    [ "$status" -eq 0 ] || return 2
    [ -s "$path" ]
}

inventory_machine_id_for_name() {
    case "$1" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
    inventory_index_healthy || return 1
    [ -s "$INVENTORY_INDEX/current/names/$1" ] || return 1
    IFS= read -r REPLY < "$INVENTORY_INDEX/current/names/$1"
    printf '%s' "$REPLY"
}

# A clone ID is allocated before its snapshot-backed volume becomes mountable.
# Keep every clone start behind the same storage lifecycle contract as the
# per-benchmark child runner.
machine_storage_ready() {  # machine_storage_ready <id>
    local value status=0
    inventory_index_healthy || status=$?
    case "$status" in 0) ;; 75) return 75 ;; *) return 2 ;; esac
    # A missing record or changed generation cannot prove native storage state.
    value="$(inventory_machine_field "$1" storage_ready)" || return 75
    case "$value" in 1) return 0 ;; 0) return 1 ;; *) return 2 ;; esac
}

machine_storage_failed() {  # machine_storage_failed <id>
    local value status=0
    inventory_index_healthy || status=$?
    case "$status" in 0) ;; 75) return 75 ;; *) return 2 ;; esac
    # A missing record or changed generation cannot prove native storage state.
    value="$(inventory_machine_field "$1" storage_failed)" || return 75
    case "$value" in 1) return 0 ;; 0) return 1 ;; *) return 2 ;; esac
}

snapshot_machine_state() {  # snapshot_machine_state <id>; 0=state, 1=absent, 2=unsafe
    inventory_machine_field "$1" state
}
