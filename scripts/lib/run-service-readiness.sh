#!/usr/bin/env bash

frontend_start_ready_attempts() {
    if [ -n "${FRONTEND_START_READY_ATTEMPTS:-}" ]; then
        printf '%s\n' "$FRONTEND_START_READY_ATTEMPTS"
    elif ${BENCHMARK_MODE:-false} && [ "${BENCHMARK_BUNDLED_FRONTEND:-false}" = "true" ]; then
        # A production Vite bundle can take more than a minute when deploy
        # coverage jobs have just released memory. Keep the tunnel smoke behind
        # the local readiness boundary instead of racing the build.
        printf '%s\n' 300
    else
        printf '%s\n' 60
    fi
}

wait_for_frontend_ready() {
    local frontend_pid="$1" frontend_port="$2" frontend_log_file="$3"
    local attempts attempt sleep_seconds
    attempts="$(frontend_start_ready_attempts)"
    sleep_seconds="${RUN_SERVICE_READY_SLEEP_SECONDS:-1}"

    case "$attempts" in
        ''|*[!0-9]*|0)
            echo "❌ FRONTEND_START_READY_ATTEMPTS must be a positive integer, got: $attempts" >&2
            return 2
            ;;
    esac

    echo "⏳ Waiting for local frontend readiness on :$frontend_port..."
    for attempt in $(seq 1 "$attempts"); do
        if curl -fsS -o /dev/null "http://127.0.0.1:$frontend_port/test_payment" 2>/dev/null; then
            echo "✅ Local frontend ready on :$frontend_port"
            return 0
        fi
        if ! kill -0 "$frontend_pid" 2>/dev/null; then
            echo "❌ Frontend process exited before becoming ready." >&2
            tail -60 "$frontend_log_file" 2>/dev/null | sed 's/^/   | /' >&2 || true
            return 1
        fi
        sleep "$sleep_seconds"
    done

    echo "❌ Frontend did not become ready after $attempts probe(s)." >&2
    tail -60 "$frontend_log_file" 2>/dev/null | sed 's/^/   | /' >&2 || true
    return 1
}
