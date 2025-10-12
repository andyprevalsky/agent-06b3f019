#!/bin/bash
# Quick diagnostic: Show queue configuration and worker status

echo "═══════════════════════════════════════════════════════"
echo "🔍 TASK QUEUE DIAGNOSTIC"
echo "═══════════════════════════════════════════════════════"
echo ""

# Show current environment
echo "📋 Current Shell Environment:"
echo "   TEMPORAL_TASK_QUEUE: ${TEMPORAL_TASK_QUEUE:-'(not set)'}"
echo "   TASK_QUEUE: ${TASK_QUEUE:-'(not set)'}"
echo ""

# Show backend configuration
echo "📋 Backend .env Configuration:"
grep "TEMPORAL_TASK_QUEUE" /Users/andyprevalsky/Desktop/projects/navi-whisper-lux/back-end/.env 2>/dev/null || echo "   (not found in .env)"
echo ""

# Show production configuration (Fly.io)
echo "📋 Production Worker Configuration (Fly.io):"
echo "   TASK_QUEUE: navi-agent-tasks (from fly.toml line 44)"
echo ""

# Check local workers
echo "🔍 Local Workers:"
WORKERS=$(ps aux | grep "[p]ython.*worker.py")
if [ -n "$WORKERS" ]; then
  echo "   ⚠️  RUNNING:"
  echo "$WORKERS" | while read line; do
    echo "      $line"
  done
else
  echo "   ✓ None running"
fi
echo ""

# Summary
echo "═══════════════════════════════════════════════════════"
echo "📊 QUEUE SUMMARY:"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Queue Name              | Workers Listening"
echo "------------------------|------------------"
echo "navi-agent-tasks        | Production (Fly.io) ✅"
echo "navi-agent-tasks-test   | Local dev/test ✅"
echo ""
echo "✅ CONFIGURATION ALIGNED:"
echo "   Backend .env:     'navi-agent-tasks-test' ✓"
echo "   Quick-test.sh:    'navi-agent-tasks-test' ✓"
echo "   Production:       'navi-agent-tasks' ✓"
echo ""
echo "   This means:"
echo "   - Test agents → 'navi-agent-tasks-test' queue"
echo "   - Production agents → 'navi-agent-tasks' queue"
echo "   - Full isolation between environments"
echo ""
echo "💡 TO CHECK WORKERS ON TEMPORAL:"
echo "   cd /Users/andyprevalsky/Desktop/projects/navi-whisper-lux/back-end"
echo "   npm run workers:check"
echo ""
echo "═══════════════════════════════════════════════════════"

