#!/bin/bash
#
# Test Rose Agent with Harbor
#

set -e

cd /tmp/terminal-bench-2

export DAYTONA_API_KEY="dtn_6f10715d7345cf314d93a85002c60872d11d26e19b7daa1325582ec81664f4c6"
export ROSE_API_URL="https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions"
export ROSE_API_KEY="${ROSE_API_KEY:-your-key-here}"
export ROSE_MAX_ITERATIONS="10"

AGENT_PATH="/Users/andyprevalsky/Desktop/projects/navi-whisper-lux/back-end/src/benchmarks/agents/rose_agent.py:RoseAgent"

echo "🧪 Testing Rose Agent with Harbor"
echo "   Task: pypi-server"
echo "   Model: rose-labs/rose-1-fast (via Rose API)"
echo "   Agent: rose-agent (custom)"
echo "   Environment: daytona"
echo ""

harbor run \
  --path pypi-server \
  -m rose-labs/rose-1-fast \
  --agent-import-path "$AGENT_PATH" \
  --env daytona \
  --force-build \
  -n 1

echo ""
echo "✅ Test complete! Check jobs/ directory for results"




