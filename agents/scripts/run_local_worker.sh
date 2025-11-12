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

# Clear the log file before starting
echo "🗑️  Clearing log file..."
> navi-worker-log.txt
echo ""

echo "📋 Logs will appear below and be saved to navi-worker-log.txt (Ctrl+C to stop):"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Run the worker and pipe logs to file while showing in terminal
python worker.py 2>&1 | tee navi-worker-log.txt

