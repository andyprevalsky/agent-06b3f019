#!/bin/bash

# Local testing script for Temporal worker

set -e

echo "🚀 Starting local Temporal worker..."
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Create .env file with required environment variables"
    exit 1
fi

# Activate virtual environment if it exists
if [ -d "venv" ]; then
    echo "📦 Activating virtual environment..."
    source venv/bin/activate
fi

# Check if dependencies are installed
if ! python -c "import temporalio" 2>/dev/null; then
    echo "❌ Error: Python dependencies not installed!"
    echo "Run: pip install -r requirements.txt"
    exit 1
fi

echo "✅ Environment ready"
echo ""

LOG_FILE="${NAVI_WORKER_LOG_FILE:-navi-worker-log.txt}"
LOG_DIR="$(dirname "$LOG_FILE")"
mkdir -p "$LOG_DIR"

# Clear the log file before starting
echo "🗑️  Clearing log file..."
> "$LOG_FILE"
echo ""

echo "📋 Logs will appear below and be saved to $LOG_FILE (Ctrl+C to stop):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Run the worker(s) and pipe logs to file while showing in terminal.
#
# WORKER_PROCESSES (default 1) launches N worker processes that all poll the
# same Temporal task queue. The Temporal Python SDK worker is single-event-loop
# / single-core, so a single process saturates one CPU core under high fan-out
# (e.g. 50 parallel sub-agents → ~470 concurrent asyncio tasks → ~1s loop lag →
# per-chunk LLM stream stalls). Running N processes spreads the activities
# across N cores — the local equivalent of prod's multi-machine Fly autoscaling.
#
# Each process needs unique metrics/health ports (they bind a Prometheus and a
# Flask server). Worker 0 keeps the run.sh-provided ports so the readiness check
# and autoscaler polling keep working; workers 1..N-1 get offset ports and their
# own log file (navi-worker-log.<i>.txt).
WORKER_PROCESSES="${WORKER_PROCESSES:-1}"
BASE_METRICS_PORT="${SDK_METRICS_PORT:-9090}"
BASE_HEALTH_PORT="${HEALTH_CHECK_PORT:-8080}"

if [ "$WORKER_PROCESSES" -le 1 ]; then
    if [ "${NAVI_WORKER_LOG_STREAM:-true}" = "false" ]; then
        python worker.py > "$LOG_FILE" 2>&1
    else
        python worker.py 2>&1 | tee "$LOG_FILE"
    fi
else
    echo "🧵 Launching $WORKER_PROCESSES worker processes across cores..."
    : > "$LOG_FILE"
    pids=()
    for i in $(seq 0 $((WORKER_PROCESSES - 1))); do
        if [ "$i" -eq 0 ]; then
            log="$LOG_FILE"
            mp="$BASE_METRICS_PORT"
            hp="$BASE_HEALTH_PORT"
        else
            log="${LOG_FILE%.*}.${i}.${LOG_FILE##*.}"
            if [ "$log" = "$LOG_FILE.$i.$LOG_FILE" ]; then
                log="$LOG_FILE.$i"
            fi
            # Use a high, unlikely-to-collide range for secondary workers so we
            # never clash with this workspace's other service ports (db/frontend/
            # mac-app sit just above the metrics/health base) or sibling worktrees.
            mp="$(( (BASE_METRICS_PORT % 1000) + 19000 + i ))"
            hp="$(( (BASE_HEALTH_PORT % 1000) + 19500 + i ))"
            : > "$log"
        fi
        SDK_METRICS_PORT="$mp" HEALTH_CHECK_PORT="$hp" WORKER_INDEX="$i" \
            python worker.py >> "$log" 2>&1 &
        pids+=($!)
    done
    tail_pid=""
    if [ "${NAVI_WORKER_LOG_STREAM:-true}" != "false" ]; then
        # Stream the primary worker's log to stdout so run.sh readiness detection and
        # live visibility keep working.
        tail -f "$LOG_FILE" &
        tail_pid=$!
    fi
    trap 'kill "${pids[@]}" ${tail_pid:+"$tail_pid"} 2>/dev/null' TERM INT
    wait "${pids[@]}"
    if [ -n "$tail_pid" ]; then
        kill "$tail_pid" 2>/dev/null || true
    fi
fi
