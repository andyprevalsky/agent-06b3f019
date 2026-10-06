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

# The supervisor sends one signal to each worker and waits for its activity and
# recording cleanup. Shell pipeline/group signals can otherwise reach a worker
# twice, which worker.py deliberately interprets as an immediate force exit.
exec python "$(dirname "${BASH_SOURCE[0]}")/local_worker_supervisor.py"
