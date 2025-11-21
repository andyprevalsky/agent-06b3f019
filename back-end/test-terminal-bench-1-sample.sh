#!/usr/bin/env bash
set -e

echo "=========================================="
echo "🧪 Terminal-Bench Integration Test"
echo "   Testing 1 sample with Rose Agent"
echo "=========================================="
echo ""

# Load env vars (using set -a to export all vars)
set -a
source .env
set +a

# Test Harbor is installed
echo "1. Checking Harbor installation..."
if harbor datasets list > /dev/null 2>&1; then
  echo "   ✅ Harbor installed"
else
  echo "   ❌ Harbor not found"
  exit 1
fi

# Check env vars
echo ""
echo "2. Checking environment variables..."
[ -n "$ROSE_API_KEY" ] && echo "   ✅ ROSE_API_KEY set" || (echo "   ❌ ROSE_API_KEY missing" && exit 1)
[ -n "$DAYTONA_API_KEY" ] && echo "   ✅ DAYTONA_API_KEY set" || (echo "   ❌ DAYTONA_API_KEY missing" && exit 1)
[ -n "$SUPABASE_URL" ] && echo "   ✅ SUPABASE_URL set" || (echo "   ❌ SUPABASE_URL missing" && exit 1)

# Check Rose agent is installed
echo ""
echo "3. Checking Rose Agent installation..."
if [ -f ~/.local/share/uv/tools/harbor/lib/python3.13/site-packages/harbor/agents/installed/rose_agent.py ]; then
  echo "   ✅ Rose Agent installed"
else
  echo "   ❌ Rose Agent not installed"
  echo "   Run: bash scripts/install-rose-agent.sh"
  exit 1
fi

# Run test via TypeScript
echo ""
echo "4. Running TypeScript test harness..."
echo "   This will call Harbor with Rose Agent for 1 Terminal-Bench task"
echo ""

npx tsx --no-warnings test-terminal-bench-harness.ts

echo ""
echo "=========================================="
echo "✅ Test complete!"
echo "=========================================="

